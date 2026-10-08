"""Huecos de API que pedía el frontend: etiquetas, asignación a compañeros, PATCH parcial y métricas."""
from app.db import FabricaSesion
from app.modelos import Contacto, Conversacion, Inscripcion, Llamada, Miembro, TroncalSip, Usuario
from app.seguridad import hash_clave


def test_listado_de_contactos_trae_etiquetas_del_espacio(cliente, sesion):
    cliente.post("/api/contactos", json={"nombre": "A", "telefono": "3001112233", "etiquetas": ["vip", "bogota"]})
    cliente.post("/api/contactos", json={"nombre": "B", "telefono": "3001112234", "etiquetas": ["vip", "lead"]})
    r = cliente.get("/api/contactos", params={"por_pagina": 1}).json()
    assert len(r["contactos"]) == 1 and r["etiquetas"] == ["bogota", "lead", "vip"]


def test_asignar_a_companero(cliente, sesion):
    e = sesion["espacios"][0]["id"]
    db = FabricaSesion()
    beto, extrano = (Usuario(email="beto@empresa.co", nombre="Beto", clave_hash=hash_clave("x" * 10)),
                     Usuario(email="x@otra.co", nombre="Extraño", clave_hash=hash_clave("x" * 10)))
    db.add_all([beto, extrano])
    db.flush()
    db.add(Miembro(espacio_id=e, usuario_id=beto.id, rol="operador"))
    c = Contacto(espacio_id=e, telefono="+573001112233")
    db.add(c)
    db.flush()
    conv = Conversacion(espacio_id=e, contacto_id=c.id, canal="whatsapp")
    db.add(conv)
    db.commit()
    ids = {"beto": beto.id, "extrano": extrano.id, "conv": conv.id}
    db.close()
    r = cliente.post(f"/api/conversaciones/{ids['conv']}/asignar", json={"usuario_id": ids["beto"]})
    assert r.status_code == 200
    assert r.json()["asignado_nombre"] == "Beto" and r.json()["ia_activa"] is False
    lista = cliente.get("/api/conversaciones").json()["conversaciones"]
    assert lista[0]["asignado_nombre"] == "Beto"
    assert cliente.post(f"/api/conversaciones/{ids['conv']}/asignar",
                        json={"usuario_id": ids["extrano"]}).status_code == 422
    r = cliente.post(f"/api/conversaciones/{ids['conv']}/asignar", json={"usuario_id": "yo"}).json()
    assert r["asignado_nombre"] == "Ana"
    r = cliente.post(f"/api/conversaciones/{ids['conv']}/asignar", json={"usuario_id": None}).json()
    assert r["asignado_a"] is None and r["ia_activa"] is True


def test_patch_parcial_de_troncal(cliente, sesion):
    t = cliente.post("/api/troncales", json={"nombre": "Op", "termination_uri": "sip.op.co", "usuario": "u",
                                             "clave": "secreta", "canales": 10}).json()
    r = cliente.patch(f"/api/troncales/{t['id']}", json={"canales": 30})
    assert r.status_code == 200, r.text
    assert r.json()["canales"] == 30 and r.json()["nombre"] == "Op" and r.json()["termination_uri"] == "sip.op.co"
    db = FabricaSesion()
    assert db.get(TroncalSip, t["id"]).clave_cifrada  # la clave se conserva
    db.close()


def test_metricas_de_secuencia_cuentan_contactos_unicos_llamados(cliente, sesion):
    e = sesion["espacios"][0]["id"]
    s = cliente.post("/api/secuencias", json={"nombre": "C", "pasos": [{"tipo": "llamada"}]}).json()
    db = FabricaSesion()
    cs = [Contacto(espacio_id=e, telefono=f"+57300111223{i}") for i in range(2)]
    db.add_all(cs)
    db.flush()
    for c, n in zip(cs, (3, 1)):
        i = Inscripcion(secuencia_id=s["id"], contacto_id=c.id)
        db.add(i)
        db.flush()
        db.add_all([Llamada(espacio_id=e, contacto_id=c.id, inscripcion_id=i.id, resultado="no_contesta")
                    for _ in range(n)])
    db.commit()
    db.close()
    m = cliente.get(f"/api/secuencias/{s['id']}/metricas").json()
    assert m["total_llamadas"] == 4 and m["contactos_llamados"] == 2


def test_panel_de_metricas_responde(cliente, sesion):
    r = cliente.get("/api/metricas", params={"desde": "2026-01-01T00:00:00"})
    assert r.status_code == 200, r.text
