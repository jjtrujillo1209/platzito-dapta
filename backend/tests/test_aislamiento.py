"""Aislamiento entre espacios y endurecimiento: nada de un espacio se puede usar desde otro."""
import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select

from app import conocimiento, secuencias
from app.cerebro.herramientas import ContextoTurno, ejecutar
from app.config import ajustes
from app.db import FabricaSesion, ahora
from app.llm import ErrorLLM
from app.llm import proveedor as proveedor_real  # conftest lo reemplaza por el LLM falso
from app.modelos import (Agente, Cerebro, Contacto, Espacio, Inscripcion, Integracion, LineaWhatsapp,
                         NumeroTelefono, Plantilla, Secuencia)
from app.seguridad import cifrar


def _otro_espacio() -> dict:
    """Crea un espacio ajeno con línea, plantilla aprobada, cerebro, número y agente."""
    db = FabricaSesion()
    e = Espacio(nombre="Ajeno")
    db.add(e)
    db.flush()
    linea = LineaWhatsapp(espacio_id=e.id, phone_number_id="PNX", waba_id="WX", token_cifrado=cifrar("t"),
                          calentamiento_desde=ahora() - timedelta(days=30))
    cerebro = Cerebro(espacio_id=e.id, nombre="Secreto")
    num = NumeroTelefono(espacio_id=e.id, numero="+5716999999")
    ag = Agente(espacio_id=e.id, nombre="Ajeno", config_borrador={}, clave_publica="pk_ajeno",
                retell_agent_id="ag_ajeno")
    db.add_all([linea, cerebro, num, ag])
    db.flush()
    pl = Plantilla(espacio_id=e.id, linea_id=linea.id, nombre="ajena", estado="APPROVED", categoria="UTILITY")
    db.add(pl)
    db.commit()
    ids = {"espacio": e.id, "linea": linea.id, "cerebro": cerebro.id, "numero": num.id, "agente": ag.id,
           "plantilla": pl.id}
    db.close()
    return ids


def test_token_por_query_string_rechazado(cliente, sesion):
    token = sesion["token"]
    del cliente.headers["authorization"]
    assert cliente.get("/api/agentes", params={"token": token}).status_code == 401
    assert cliente.get("/api/agentes", headers={"authorization": f"Bearer {token}"}).status_code == 200


@pytest.mark.parametrize("tipo,config", [("ollama", {"url": "http://127.0.0.1:9"}),
                                         ("openai", {"api_key": "sk-x", "base_url": "http://169.254.169.254/v1"})])
def test_llm_rechaza_url_interna_del_espacio(cliente, sesion, monkeypatch, tipo, config):
    e = sesion["espacios"][0]["id"]
    db = FabricaSesion()
    db.add(Integracion(espacio_id=e, tipo=tipo, config_cifrada=cifrar(config)))
    db.commit()
    monkeypatch.setattr(ajustes(), "entorno", "produccion")
    with pytest.raises(ErrorLLM):
        proveedor_real(db, e, tipo, "modelo")
    # La URL de Ollama del .env es de confianza aunque sea local
    assert proveedor_real(db, None, "ollama", "modelo")
    db.close()


def test_agente_no_acepta_cerebro_ni_plantilla_ajenos(cliente, sesion):
    otro = _otro_espacio()
    a = cliente.post("/api/agentes", json={"nombre": "X"}).json()
    cfg = a["config"]
    cfg["conocimiento"]["cerebro_ids"] = [otro["cerebro"]]
    assert cliente.patch(f"/api/agentes/{a['id']}", json={"config": cfg}).status_code == 422
    cfg = a["config"]
    cfg["conocimiento"]["cerebro_ids"] = []
    cfg["herramientas"] = [{"tipo": "enviar_plantilla_whatsapp", "config": {"plantilla_id": otro["plantilla"]}}]
    assert cliente.patch(f"/api/agentes/{a['id']}", json={"config": cfg}).status_code == 422
    assert cliente.post("/api/agentes", json={"nombre": "Y", "config": cfg}).status_code == 422


def test_herramientas_ignoran_recursos_ajenos(cliente, sesion, red):
    # Cerebro con contenido en otro espacio (creado por otro usuario)
    r = cliente.post("/api/auth/registro", json={"nombre": "Beto", "email": "beto@otra.co", "clave": "clave-segura-2",
                                                 "espacio": "Otra"}, headers={"authorization": ""})
    hb = {"authorization": f"Bearer {r.json()['token']}"}
    espacio_b = r.json()["espacios"][0]["id"]
    c = cliente.post("/api/cerebros", json={"nombre": "Privado"}, headers=hb).json()
    f = cliente.post(f"/api/cerebros/{c['id']}/fuentes", headers=hb, json={
        "tipo": "texto", "nombre": "Clave", "texto": "El código interno de la bóveda es 4242."}).json()
    db = FabricaSesion()
    asyncio.run(conocimiento.procesar_fuente(db, f["id"]))
    otro = _otro_espacio()
    espacio_a = sesion["espacios"][0]["id"]
    contacto = Contacto(espacio_id=espacio_a, telefono="+573001112233")
    db.add(contacto)
    db.commit()
    cfg = {"conocimiento": {"cerebro_ids": [c["id"]], "top_k": 4, "umbral": 0.0},
           "herramientas": [{"tipo": "buscar_conocimiento"},
                            {"tipo": "enviar_plantilla_whatsapp", "config": {"plantilla_id": otro["plantilla"]}}]}

    def ctx(espacio_id):
        return ContextoTurno(db=db, espacio_id=espacio_id, agente=None, config=cfg, canal="widget", contacto=contacto)

    consulta = {"consulta": "código interno de la bóveda"}
    assert "4242" in asyncio.run(ejecutar(ctx(espacio_b), "buscar_conocimiento", consulta))
    assert "4242" not in asyncio.run(ejecutar(ctx(espacio_a), "buscar_conocimiento", consulta))
    res = asyncio.run(ejecutar(ctx(espacio_a), "enviar_plantilla_whatsapp", {}))
    assert res.startswith("No se pudo enviar")  # respx falla si se intentara llamar a Meta
    db.close()


def test_secuencia_no_usa_recursos_ajenos(cliente, sesion):
    otro = _otro_espacio()
    e = sesion["espacios"][0]["id"]
    # La API rechaza la línea ajena
    r = cliente.post("/api/secuencias", json={"nombre": "X", "pasos": [{"tipo": "whatsapp"}],
                                              "linea_id": otro["linea"]})
    assert r.status_code == 422
    # Aunque una secuencia vieja apunte a recursos ajenos, el motor no los usa
    db = FabricaSesion()
    c = Contacto(espacio_id=e, telefono="+573001112233", zona_horaria="America/Bogota")
    ajeno = Contacto(espacio_id=otro["espacio"], telefono="+573009998877")
    db.add_all([c, ajeno])
    db.flush()
    casos = [
        ([{"tipo": "whatsapp", "plantilla_id": otro["plantilla"]}], {}, "config:la plantilla no pertenece"),
        ([{"tipo": "whatsapp"}], {"linea_id": otro["linea"]}, "config:la línea de WhatsApp no pertenece"),
        ([{"tipo": "llamada", "agente_id": otro["agente"]}], {"numeros_ids": [otro["numero"]]},
         "config:el agente de voz no pertenece"),
    ]
    for pasos, extra, esperado in casos:
        sec = Secuencia(espacio_id=e, nombre="vieja", pasos=secuencias.validar_pasos(pasos), estado="activa",
                        horario={}, **extra)
        db.add(sec)
        db.commit()
        assert secuencias.inscribir(db, sec, [c.id, ajeno.id]) == 1  # el contacto ajeno se ignora
        insc = db.scalar(select(Inscripcion).where(Inscripcion.secuencia_id == sec.id))
        assert asyncio.run(secuencias.procesar(db, insc, sec)).startswith(esperado)
    # Número ajeno y A/B con agente ajeno
    sec = Secuencia(espacio_id=e, nombre="ab", pasos=secuencias.validar_pasos([{"tipo": "llamada"}]),
                    ab_agentes={str(otro["agente"]): 100}, numeros_ids=[otro["numero"]], horario={})
    db.add(sec)
    db.commit()
    assert secuencias._elegir_agente(db, sec) is None
    assert secuencias._elegir_numero(db, sec, c) is None
    db.close()
