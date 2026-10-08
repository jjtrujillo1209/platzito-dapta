"""Motor de secuencias: franjas, reintentos, cooldown, fallback a WhatsApp, dedupe y pausa por configuración."""
import asyncio
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select

from app import secuencias
from app.db import FabricaSesion, ahora
from app.modelos import (Contacto, Envio, Inscripcion, LineaWhatsapp, Llamada, NumeroTelefono, Plantilla, Secuencia)
from app.seguridad import cifrar

GRAPH = "https://graph.facebook.com/v23.0"
TODO_EL_DIA = {d: [["00:00", "23:59"]] for d in secuencias.DIAS}


def test_proxima_ventana():
    bog = ZoneInfo("America/Bogota")
    horario = {"lun": [["09:00", "12:00"], ["14:00", "18:00"]]}
    # Lunes 2026-10-05 13:00 Bogotá = 18:00 UTC → siguiente franja 14:00 Bogotá = 19:00 UTC
    r = secuencias.proxima_ventana(datetime(2026, 10, 5, 18, 0), bog, horario)
    assert r == datetime(2026, 10, 5, 19, 0)
    # Dentro de franja: se queda igual
    assert secuencias.proxima_ventana(datetime(2026, 10, 5, 15, 0), bog, horario) == datetime(2026, 10, 5, 15, 0)
    # Lunes 19:00 Bogotá → el siguiente lunes 09:00
    assert secuencias.proxima_ventana(datetime(2026, 10, 6, 0, 0), bog, horario) == datetime(2026, 10, 12, 14, 0)


def _base(sesion, cliente, pasos, **extra):
    e = sesion["espacios"][0]["id"]
    a = cliente.post("/api/agentes", json={"nombre": "Voz"}).json()
    cliente.post(f"/api/agentes/{a['id']}/publicar", json={})
    db = FabricaSesion()
    linea = LineaWhatsapp(espacio_id=e, phone_number_id="PN1", waba_id="W1", token_cifrado=cifrar("tok"),
                          calentamiento_desde=ahora() - timedelta(days=30))
    num = NumeroTelefono(espacio_id=e, numero="+5716000000")
    db.add_all([linea, num])
    db.flush()
    pl = Plantilla(espacio_id=e, linea_id=linea.id, nombre="seguimiento", idioma="es", estado="APPROVED",
                   cuerpo="Hola {{1}}, te llamamos de Platzi", n_variables=1, categoria="MARKETING")
    c = Contacto(espacio_id=e, nombre="Laura Gómez", telefono="+573001112233", zona_horaria="America/Bogota")
    db.add_all([pl, c])
    db.commit()
    ids = {"agente": a["id"], "linea": linea.id, "numero": num.id, "plantilla": pl.id, "contacto": c.id}
    db.close()
    pasos = [{k: (ids[v[1:]] if isinstance(v, str) and v.startswith("$") else v) for k, v in p.items()}
             for p in pasos]
    s = cliente.post("/api/secuencias", json={
        "nombre": "Campaña", "pasos": pasos, "horario": TODO_EL_DIA, "ab_agentes": {str(a["id"]): 100},
        "numeros_ids": [ids["numero"]], "linea_id": ids["linea"], "segundos_entre_llamadas": 1, **extra})
    assert s.status_code == 200, s.text
    sec = s.json()
    cliente.post(f"/api/secuencias/{sec['id']}/activar")
    assert cliente.post(f"/api/secuencias/{sec['id']}/inscribir", json={"contacto_ids": [ids["contacto"]]}
                        ).json()["inscritos"] == 1
    return sec, ids


def _tick():
    db = FabricaSesion()
    try:
        return asyncio.run(secuencias.tick(db))
    finally:
        db.close()


def _insc():
    db = FabricaSesion()
    i = db.scalar(select(Inscripcion))
    db.close()
    return i


def _terminar_llamada(resultado_retell: str, duracion_ms: int):
    db = FabricaSesion()
    l = db.scalars(select(Llamada).order_by(Llamada.id.desc())).first()
    from app.rutas.voz import aplicar_datos_llamada

    aplicar_datos_llamada(db, l, {"call_status": "ended", "disconnection_reason": resultado_retell,
                                  "duration_ms": duracion_ms})
    asyncio.run(secuencias.al_terminar_llamada(db, l))
    db.close()


def _mover_reloj_inscripcion(minutos: int):
    """Simula que pasó el tiempo: adelanta proximo_en y envejece los envíos (cooldown)."""
    db = FabricaSesion()
    i = db.scalar(select(Inscripcion))
    i.proximo_en = ahora() - timedelta(seconds=1)
    i.dia_intentos = ""
    for e in db.scalars(select(Envio)):
        e.creado = e.creado - timedelta(minutes=minutos)
    db.commit()
    db.close()


def test_llamada_reintentos_y_fallback_whatsapp(cliente, sesion, red):
    llamadas, wa = [], []
    red.post("https://api.retellai.com/v2/create-phone-call").mock(side_effect=lambda r: (
        llamadas.append(json.loads(r.content)), httpx.Response(201, json={"call_id": f"c{len(llamadas)}"}))[1])
    red.post(f"{GRAPH}/PN1/messages").mock(side_effect=lambda r: (
        wa.append(json.loads(r.content)), httpx.Response(200, json={"messages": [{"id": f"w{len(wa)}"}]}))[1])
    sec, ids = _base(sesion, cliente, [
        {"tipo": "llamada", "max_intentos": 2, "intentos_por_dia": 3, "reintento_min": 30,
         "whatsapp_tras_intento": 1, "plantilla_fallback_id": "$plantilla"},
        {"tipo": "whatsapp", "condicion": "no_conecto", "espera_min": 0, "plantilla_id": "$plantilla",
         "variables": ["{{primer_nombre}}"]},
    ])
    _tick()
    assert len(llamadas) == 1 and llamadas[0]["to_number"] == "+573001112233"
    assert llamadas[0]["retell_llm_dynamic_variables"]["primer_nombre"] == "Laura"
    assert _insc().estado == "esperando"
    _tick()  # mientras espera el resultado no se vuelve a llamar
    assert len(llamadas) == 1
    _terminar_llamada("dial_no_answer", 0)
    i = _insc()
    assert i.estado == "activa" and i.paso == 0 and i.proximo_en > ahora() + timedelta(minutes=25)
    assert len(wa) == 1 and wa[0]["template"]["name"] == "seguimiento"  # fallback tras intento 1
    # Cooldown global: aunque proximo_en venza, si la última llamada fue hace < 1 h se pospone
    db = FabricaSesion()
    db.scalar(select(Inscripcion)).proximo_en = ahora() - timedelta(seconds=1)
    db.commit()
    db.close()
    _tick()
    assert len(llamadas) == 1
    _mover_reloj_inscripcion(61)
    _tick()
    assert len(llamadas) == 2
    _terminar_llamada("voicemail_reached", 8000)
    # Agotó intentos → paso 2 (WhatsApp, porque nunca conectó) pero dedupe 24 h lo pospone
    i = _insc()
    assert i.paso == 1
    _tick()
    assert len(wa) == 1 and _insc().proximo_en > ahora() + timedelta(hours=20)
    _mover_reloj_inscripcion(60 * 25)
    _tick()
    assert len(wa) == 2 and wa[1]["template"]["components"][0]["parameters"][0]["text"] == "Laura"
    assert _insc().estado == "completada"
    m = cliente.get(f"/api/secuencias/{sec['id']}/metricas").json()
    assert m["total_llamadas"] == 2 and m["tasa_conexion"] == 0


def test_contesta_y_omite_fallback(cliente, sesion, red):
    red.post("https://api.retellai.com/v2/create-phone-call").respond(201, json={"call_id": "c1"})
    sec, _ = _base(sesion, cliente, [
        {"tipo": "llamada", "max_intentos": 3},
        {"tipo": "whatsapp", "condicion": "no_conecto", "plantilla_id": "$plantilla"},
    ])
    _tick()
    _terminar_llamada("user_hangup", 45000)
    i = _insc()
    assert i.conecto is True and i.paso == 1
    _tick()
    assert _insc().estado == "completada"  # el WhatsApp se omitió porque sí conectó


def test_error_de_configuracion_pausa_secuencia(cliente, sesion):
    sec, _ = _base(sesion, cliente, [{"tipo": "llamada"}], numeros_ids=[])
    _tick()
    assert cliente.get(f"/api/secuencias/{sec['id']}").json()["estado"] == "pausada"
    assert _insc().estado == "activa"  # el contacto no se quemó


def test_fuera_de_franja_no_cuenta_intento(cliente, sesion, red):
    ruta = red.post("https://api.retellai.com/v2/create-phone-call").respond(201, json={"call_id": "c1"})
    ahora_bog = datetime.now(ZoneInfo("America/Bogota"))
    dia = secuencias.DIAS[(ahora_bog.weekday() + 2) % 7]
    _base(sesion, cliente, [{"tipo": "llamada"}], horario={dia: [["10:00", "11:00"]]})
    _tick()
    i = _insc()
    assert not ruta.called and i.intentos_paso == 0 and i.proximo_en > ahora() + timedelta(hours=12)


def test_respuesta_detiene_secuencia(cliente, sesion):
    _base(sesion, cliente, [{"tipo": "esperar", "espera_min": 60}, {"tipo": "llamada"}])
    db = FabricaSesion()
    secuencias.al_responder(db, db.scalar(select(Contacto)).id)
    db.close()
    assert _insc().estado == "respondio"


def test_tope_whatsapp_calentamiento():
    l = LineaWhatsapp(tier="TIER_1K", calidad="GREEN", calentamiento_desde=ahora() - timedelta(days=1), id=999)
    assert secuencias.tope_whatsapp(FabricaSesion(), l) == 50
    l.calentamiento_desde = ahora() - timedelta(days=5)
    assert secuencias.tope_whatsapp(FabricaSesion(), l) == 150
    l.calidad = "YELLOW"
    assert secuencias.tope_whatsapp(FabricaSesion(), l) == 75


def test_ab_pesos_validados(cliente, sesion):
    a = cliente.post("/api/agentes", json={"nombre": "A"}).json()
    r = cliente.post("/api/secuencias", json={"nombre": "X", "pasos": [{"tipo": "llamada"}],
                                              "ab_agentes": {str(a["id"]): 60}})
    assert r.status_code == 422


def test_secuencia_vacia_no_activa(cliente, sesion):
    s = cliente.post("/api/secuencias", json={"nombre": "X"}).json()
    assert cliente.post(f"/api/secuencias/{s['id']}/activar").status_code == 422


def test_inscripcion_unica(cliente, sesion):
    sec, ids = _base(sesion, cliente, [{"tipo": "esperar"}])
    r = cliente.post(f"/api/secuencias/{sec['id']}/inscribir", json={"contacto_ids": [ids["contacto"]]})
    assert r.json() == {"inscritos": 0, "omitidos": 1}
    db = FabricaSesion()
    assert len(db.scalars(select(Secuencia)).all()) == 1
    db.close()
