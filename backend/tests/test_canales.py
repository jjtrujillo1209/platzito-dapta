"""WhatsApp (webhook firmado, dedupe, respuesta IA, estados, opt-out), Retell (webhook firmado y
WebSocket de Custom LLM), widget, MCP, importación y webhooks salientes."""
import hashlib
import hmac
import json
import time

import httpx
import pytest
from starlette.websockets import WebSocketDisconnect
from sqlalchemy import select

from app.db import FabricaSesion
from app.modelos import Contacto, Conversacion, Espacio, Integracion, LineaWhatsapp, Llamada, Mensaje, Plantilla
from app.canales.retell import firma_ws, url_ws
from app.seguridad import cifrar, firmar_webhook

GRAPH = "https://graph.facebook.com/v23.0"


def _firmar_meta(cuerpo: bytes) -> str:
    return "sha256=" + hmac.new(b"secreto-meta", cuerpo, hashlib.sha256).hexdigest()


def _linea(espacio_id: int, agente_id: int | None) -> LineaWhatsapp:
    db = FabricaSesion()
    l = LineaWhatsapp(espacio_id=espacio_id, phone_number_id="PN1", waba_id="WABA1", numero_visible="+57 300 000 0000",
                      token_cifrado=cifrar("token-meta-negocio"), agente_id=agente_id)
    db.add(l)
    db.commit()
    db.refresh(l)
    db.close()
    return l


def _agente_publicado(cliente, **cambios) -> dict:
    a = cliente.post("/api/agentes", json={"nombre": "WA"}).json()
    cfg = a["config"]
    cfg.update(cambios)
    cliente.patch(f"/api/agentes/{a['id']}", json={"config": cfg})
    return cliente.post(f"/api/agentes/{a['id']}/publicar", json={}).json()


def _entrante(texto: str, wamid: str, de: str = "573001112233") -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": "WABA1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"phone_number_id": "PN1"},
        "contacts": [{"wa_id": de, "profile": {"name": "Carlos"}}],
        "messages": [{"from": de, "id": wamid, "timestamp": str(int(time.time())), "type": "text",
                      "text": {"body": texto}}]}}]}]}


def _esperar(condicion, segundos=5.0):
    fin = time.time() + segundos
    while time.time() < fin:
        if condicion():
            return True
        time.sleep(0.05)
    return False


def test_webhook_whatsapp_verificacion(cliente):
    r = cliente.get("/webhooks/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "platzito-verify",
                                                  "hub.challenge": "1234"})
    assert r.text == "1234"
    assert cliente.get("/webhooks/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "x",
                                                     "hub.challenge": "1"}).status_code == 403


def test_webhook_whatsapp_firma_invalida(cliente, sesion):
    cuerpo = json.dumps(_entrante("hola", "wamid.X")).encode()
    r = cliente.post("/webhooks/whatsapp", content=cuerpo, headers={"x-hub-signature-256": "sha256=malo"})
    assert r.status_code == 401


def test_whatsapp_entrante_responde_ia_y_dedupe(cliente, sesion, guion, red, monkeypatch):
    from app.cerebro import motor

    a = _agente_publicado(cliente)
    linea = _linea(sesion["espacios"][0]["id"], a["id"])
    enviados = []

    def capturar(request):
        enviados.append(json.loads(request.content))
        return httpx.Response(200, json={"messages": [{"id": f"wamid.OUT{len(enviados)}"}]})

    red.post(f"{GRAPH}/PN1/messages").mock(side_effect=capturar)
    monkeypatch.setattr(motor.asyncio, "sleep", _sin_espera)
    guion.guion = ["¡Hola Carlos! ¿En qué te ayudo?"]
    cuerpo = json.dumps(_entrante("Hola, info por favor", "wamid.IN1")).encode()
    for _ in range(2):  # Meta reintenta: el segundo debe ignorarse
        r = cliente.post("/webhooks/whatsapp", content=cuerpo, headers={"x-hub-signature-256": _firmar_meta(cuerpo)})
        assert r.status_code == 200
    assert _esperar(lambda: any(e.get("type") == "text" for e in enviados))
    texto = [e for e in enviados if e.get("type") == "text"]
    assert len(texto) == 1 and texto[0]["text"]["body"].startswith("¡Hola Carlos!")
    assert texto[0]["to"] == "573001112233"
    db = FabricaSesion()
    contacto = db.scalar(select(Contacto).where(Contacto.telefono == "+573001112233"))
    assert contacto.nombre == "Carlos" and contacto.zona_horaria == "America/Bogota"
    conv = db.scalar(select(Conversacion).where(Conversacion.contacto_id == contacto.id))
    assert db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id, Mensaje.autor == "contacto")
                      ).all().__len__() == 1
    db.close()
    # Estado de entrega
    estado = {"entry": [{"changes": [{"field": "messages", "value": {"metadata": {"phone_number_id": "PN1"},
                                                                     "statuses": [{"id": "wamid.OUT2",
                                                                                   "status": "read"}]}}]}]}
    c2 = json.dumps(estado).encode()
    cliente.post("/webhooks/whatsapp", content=c2, headers={"x-hub-signature-256": _firmar_meta(c2)})
    db = FabricaSesion()
    assert db.scalar(select(Mensaje).where(Mensaje.wamid == "wamid.OUT2")).estado_entrega == "leido"
    db.close()


async def _sin_espera(_):
    return None


def test_whatsapp_opt_out(cliente, sesion, red, monkeypatch):
    a = _agente_publicado(cliente)
    _linea(sesion["espacios"][0]["id"], a["id"])
    red.post(f"{GRAPH}/PN1/messages").respond(json={"messages": [{"id": "wamid.BAJA"}]})
    cuerpo = json.dumps(_entrante("STOP", "wamid.IN9")).encode()
    cliente.post("/webhooks/whatsapp", content=cuerpo, headers={"x-hub-signature-256": _firmar_meta(cuerpo)})
    db = FabricaSesion()
    assert _esperar(lambda: db.scalar(select(Contacto.opt_out_whatsapp).where(
        Contacto.telefono == "+573001112233")) is True)
    db.close()


def test_humano_toma_conversacion_apaga_ia(cliente, sesion, red):
    a = _agente_publicado(cliente)
    _linea(sesion["espacios"][0]["id"], a["id"])
    red.post(f"{GRAPH}/PN1/messages").respond(json={"messages": [{"id": "wamid.H"}]})
    cuerpo = json.dumps(_entrante("hola", "wamid.IN2")).encode()
    cliente.post("/webhooks/whatsapp", content=cuerpo, headers={"x-hub-signature-256": _firmar_meta(cuerpo)})
    conv = cliente.get("/api/conversaciones").json()["conversaciones"][0]
    r = cliente.post(f"/api/conversaciones/{conv['id']}/mensajes", json={"texto": "Hola, soy Ana del equipo"})
    assert r.status_code == 200
    detalle = cliente.get(f"/api/conversaciones/{conv['id']}").json()
    assert detalle["ia_activa"] is False and detalle["ventana_24h"]["abierta"] is True
    r = cliente.post(f"/api/conversaciones/{conv['id']}/asignar", json={"usuario_id": None})
    assert r.json()["ia_activa"] is True


# ─────────────────────────────── Voz ───────────────────────────────

def _firmar_retell(cuerpo: bytes) -> str:
    ts = str(int(time.time() * 1000))
    d = hmac.new(b"key_retell_prueba", cuerpo + ts.encode(), hashlib.sha256).hexdigest()
    return f"v={ts},d={d}"


def test_websocket_custom_llm(cliente, sesion, guion):
    a = _agente_publicado(cliente, mensaje_inicial="Hola {{nombre}}, te llamo de Platzi.")
    guion.guion = [{"texto": "Perfecto, hasta luego, que tengas buen día.", "llamadas": [{"nombre": "colgar"}]}]
    with cliente.websocket_connect(f"/voz/llm/{a['id']}/{firma_ws(a['id'])}/call_abc") as ws:
        config = json.loads(ws.receive_text())
        assert config["response_type"] == "config"
        ws.send_text(json.dumps({"interaction_type": "call_details", "call": {
            "call_id": "call_abc", "from_number": "+573005556677", "to_number": "+5716000000",
            "direction": "inbound", "retell_llm_dynamic_variables": {"nombre": "Laura"}}}))
        saludo = json.loads(ws.receive_text())
        assert saludo["response_id"] == 0 and saludo["content"] == "Hola Laura, te llamo de Platzi."
        ws.send_text(json.dumps({"interaction_type": "ping_pong", "timestamp": 1}))
        assert json.loads(ws.receive_text())["response_type"] == "ping_pong"
        ws.send_text(json.dumps({"interaction_type": "response_required", "response_id": 1, "transcript": [
            {"role": "agent", "content": "Hola Laura, te llamo de Platzi."},
            {"role": "user", "content": "No gracias, eso es todo, adiós"}]}))
        trozos = []
        while True:
            m = json.loads(ws.receive_text())
            if m["response_type"] == "response":
                trozos.append(m)
                if m["content_complete"]:
                    break
        assert "hasta luego" in "".join(t["content"] for t in trozos)
        assert trozos[-1]["end_call"] is True
    db = FabricaSesion()
    llamada = db.scalar(select(Llamada).where(Llamada.retell_call_id == "call_abc"))
    assert llamada and llamada.direccion == "inbound" and llamada.latencia_ms is not None
    msjs = db.scalars(select(Mensaje).where(Mensaje.conversacion_id == llamada.conversacion_id)).all()
    assert any(m.autor == "contacto" for m in msjs)
    db.close()


def test_websocket_voz_rechaza_firma_invalida(cliente, sesion):
    a = _agente_publicado(cliente)
    assert url_ws(a["id"]).endswith(f"/voz/llm/{a['id']}/{firma_ws(a['id'])}")
    for ruta in (f"/voz/llm/{a['id']}/firma-falsa/call_x", f"/voz/llm/{a['id'] + 1}/{firma_ws(a['id'])}/call_x"):
        with pytest.raises(WebSocketDisconnect) as e:
            with cliente.websocket_connect(ruta) as ws:
                ws.receive_text()
        assert e.value.code == 1008


def test_websocket_voz_ignora_llamada_de_otro_espacio(cliente, sesion, guion):
    a = _agente_publicado(cliente)
    db = FabricaSesion()
    otro = Espacio(nombre="Otro")
    db.add(otro)
    db.flush()
    ajena = Llamada(espacio_id=otro.id, retell_call_id="call_ajena")
    db.add(ajena)
    db.commit()
    ajena_id = ajena.id
    db.close()
    with cliente.websocket_connect(f"/voz/llm/{a['id']}/{firma_ws(a['id'])}/call_mia") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"interaction_type": "call_details", "call": {
            "call_id": "call_mia", "from_number": "+573005556677", "metadata": {"llamada_id": ajena_id}}}))
        ws.receive_text()
    db = FabricaSesion()
    ajena = db.get(Llamada, ajena_id)
    assert ajena.retell_call_id == "call_ajena" and ajena.estado != "en_curso"
    mia = db.scalar(select(Llamada).where(Llamada.retell_call_id == "call_mia"))
    assert mia and mia.espacio_id == sesion["espacios"][0]["id"]
    db.close()


def test_webhook_retell_firmado(cliente, sesion, guion):
    a = _agente_publicado(cliente)
    db = FabricaSesion()
    conv = Conversacion(espacio_id=sesion["espacios"][0]["id"], agente_id=a["id"], canal="voz")
    db.add(conv)
    db.flush()
    l = Llamada(espacio_id=conv.espacio_id, conversacion_id=conv.id, agente_id=a["id"], retell_call_id="call_1")
    db.add(l)
    db.commit()
    db.close()
    cuerpo = json.dumps({"event": "call_ended", "call": {
        "call_id": "call_1", "call_status": "ended", "start_timestamp": 1_700_000_000_000,
        "end_timestamp": 1_700_000_065_000, "disconnection_reason": "user_hangup",
        "recording_url": "https://x/rec.wav", "call_cost": {"combined_cost": 12.5},
        "transcript_object": [{"role": "agent", "content": "Hola"}, {"role": "user", "content": "Hola, sí dime"}]}}
    ).encode()
    assert cliente.post("/webhooks/retell", content=cuerpo, headers={"x-retell-signature": "v=1,d=x"}
                        ).status_code == 401
    guion.guion = [{"llamadas": [{"nombre": "registrar_analisis", "args": {
        "resumen": "Saludo breve", "exito": True, "sentimiento": "positivo"}}]}]
    r = cliente.post("/webhooks/retell", content=cuerpo, headers={"x-retell-signature": _firmar_retell(cuerpo)})
    assert r.status_code == 200
    detalle = cliente.get("/api/llamadas").json()["llamadas"][0]
    assert detalle["resultado"] == "contestada" and detalle["duracion_s"] == 65 and detalle["costo_usd"] == 0.125
    assert detalle["resumen"] == "Saludo breve" and detalle["exito"] is True


# ─────────────────────────────── Widget, MCP, importación, webhooks ───────────────────────────────

def test_widget_chat(cliente, sesion, guion):
    a = _agente_publicado(cliente, mensaje_inicial="¡Hola! ¿En qué te ayudo?")
    cfg = cliente.get(f"/widget/{a['clave_publica']}/config").json()
    assert cfg["saludo"] == "¡Hola! ¿En qué te ayudo?"
    s = cliente.post(f"/widget/{a['clave_publica']}/sesion", json={"nombre": "Visitante"}).json()
    assert s["mensajes"][0]["contenido"] == "¡Hola! ¿En qué te ayudo?"
    guion.guion = ["Claro, con gusto."]
    r = cliente.post(f"/widget/{a['clave_publica']}/mensajes", json={"texto": "Hola"},
                     headers={"x-widget-token": s["token"]})
    assert r.json()["mensajes"][-1]["contenido"] == "Claro, con gusto."
    assert cliente.post(f"/widget/{a['clave_publica']}/mensajes", json={"texto": "x"},
                        headers={"x-widget-token": "malo"}).status_code == 401


def test_mcp_con_clave_api(cliente, sesion):
    clave = cliente.post("/api/claves-api", json={"nombre": "MCP", "rol": "editor"}).json()["clave"]
    h = {"authorization": f"Bearer {clave}"}
    init = cliente.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                        headers=h).json()
    assert init["result"]["serverInfo"]["name"] == "platzito"
    tools = cliente.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=h).json()
    assert any(t["name"] == "metricas" for t in tools["result"]["tools"])
    previa = cliente.post("/mcp", json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "crear_contacto", "arguments": {"nombre": "Pedro", "telefono": "3001234567"}}}, headers=h).json()
    assert "vista_previa" in previa["result"]["content"][0]["text"]
    assert cliente.get("/api/contactos", headers=h).json()["total"] == 0
    cliente.post("/mcp", json={"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
        "name": "crear_contacto", "arguments": {"nombre": "Pedro", "telefono": "3001234567", "confirmar": True}}},
        headers=h)
    assert cliente.get("/api/contactos", headers=h).json()["contactos"][0]["telefono"] == "+573001234567"


def test_importar_csv(cliente, sesion):
    csv_ = "Nombre;Celular;Correo;Ciudad\nAna;300 111 2233;ana@x.co;Bogotá\nSin datos;;;\nLuis;+52 55 1234 5678;;CDMX\n"
    r = cliente.post("/api/contactos/importar", files={"archivo": ("lista.csv", csv_.encode(), "text/csv")},
                     data={"etiquetas": "feria"})
    assert r.json() == {"creados": 2, "actualizados": 0, "invalidos": 1, "inscritos": 0}
    contactos = cliente.get("/api/contactos").json()["contactos"]
    luis = next(c for c in contactos if c["nombre"] == "Luis")
    assert luis["telefono"] == "+525512345678" and luis["zona_horaria"] == "America/Mexico_City"
    assert luis["atributos"]["ciudad"] == "CDMX" and "feria" in luis["etiquetas"]


def test_webhook_saliente_firmado(cliente, sesion, red):
    recibido = {}

    def capturar(request):
        recibido["firma"] = request.headers["x-platzito-firma"]
        recibido["cuerpo"] = request.content
        return httpx.Response(200)

    red.post("https://hooks.cliente.co/platzito").mock(side_effect=capturar)
    sub = cliente.post("/api/webhooks", json={"url": "https://hooks.cliente.co/platzito", "eventos": ["*"]}).json()
    r = cliente.post(f"/api/webhooks/{sub['id']}/probar")
    assert r.json()["ok"] is True
    ts = int(recibido["firma"].split(",")[0][2:])
    assert recibido["firma"] == firmar_webhook(sub["secreto"], recibido["cuerpo"], ts)


def test_webhook_whatsapp_firma_de_espacio_solo_toca_su_espacio(cliente, sesion):
    """Un espacio con su propio app secret no puede alterar líneas ni plantillas de otro espacio."""
    a = _linea(sesion["espacios"][0]["id"], None)
    db = FabricaSesion()
    otro = Espacio(nombre="Otro")
    db.add(otro)
    db.flush()
    db.add(Integracion(espacio_id=otro.id, tipo="meta", config_cifrada=cifrar({"app_secret": "secreto-b"})))
    b = LineaWhatsapp(espacio_id=otro.id, phone_number_id="PN2", waba_id="WABA2", numero_visible="+57 301",
                      token_cifrado=cifrar("t"))
    db.add(b)
    db.flush()
    db.add_all([Plantilla(espacio_id=a.espacio_id, linea_id=a.id, nombre="p", meta_id="T1", estado="PENDING"),
                Plantilla(espacio_id=otro.id, linea_id=b.id, nombre="p", meta_id="T1", estado="PENDING")])
    db.commit()
    db.close()

    def firmar_b(c: bytes) -> str:
        return "sha256=" + hmac.new(b"secreto-b", c, hashlib.sha256).hexdigest()

    # Solo menciona la línea del espacio A: B no es candidato y nadie valida la firma
    cuerpo = json.dumps(_entrante("hola", "wamid.AJENO")).encode()
    assert cliente.post("/webhooks/whatsapp", content=cuerpo,
                        headers={"x-hub-signature-256": firmar_b(cuerpo)}).status_code == 401
    # Mezcla la línea de B con la de A y una plantilla con el mismo meta_id en ambos espacios
    mezcla = _entrante("hola", "wamid.MEZCLA")
    mezcla["entry"].append({"id": "WABA2", "changes": [{"field": "message_template_status_update", "value": {
        "message_template_id": "T1", "event": "APPROVED"}}]})
    cuerpo = json.dumps(mezcla).encode()
    assert cliente.post("/webhooks/whatsapp", content=cuerpo,
                        headers={"x-hub-signature-256": firmar_b(cuerpo)}).status_code == 200
    db = FabricaSesion()
    estados = {p.espacio_id: p.estado for p in db.scalars(select(Plantilla))}
    assert estados == {a.espacio_id: "PENDING", otro.id: "APPROVED"}
    assert db.scalar(select(Mensaje).where(Mensaje.wamid == "wamid.MEZCLA")) is None
    db.close()
