"""El widget nunca adjunta la sesión anónima a un contacto existente por teléfono declarado."""
from sqlalchemy import select

from app.db import FabricaSesion
from app.modelos import Contacto, Conversacion


def test_widget_no_reutiliza_contacto_existente(cliente, sesion):
    a = cliente.post("/api/agentes", json={"nombre": "Web"}).json()
    a = cliente.post(f"/api/agentes/{a['id']}/publicar", json={}).json()
    existente = cliente.post("/api/contactos", json={"nombre": "Cliente VIP", "telefono": "3001112233"}).json()
    s = cliente.post(f"/widget/{a['clave_publica']}/sesion", json={"nombre": "Intruso", "telefono": "3001112233"})
    assert s.status_code == 200
    db = FabricaSesion()
    conv = db.scalars(select(Conversacion).where(Conversacion.canal == "widget")).one()
    nuevo = db.get(Contacto, conv.contacto_id)
    assert nuevo.id != existente["id"] and nuevo.telefono is None
    assert nuevo.atributos["telefono_declarado"] == "3001112233" and nuevo.nombre == "Intruso"
    db.close()


def test_widget_sirve_sdk_propio_y_demo(cliente):
    js = cliente.get("/widget.js").text
    assert "jsdelivr" not in js and "/widget/retell-sdk.mjs" in js
    sdk = cliente.get("/widget/retell-sdk.mjs")
    assert sdk.status_code == 200 and "javascript" in sdk.headers["content-type"]
    assert "RetellWebClient" in sdk.text and 'from"livekit-client"' not in sdk.text  # empaquetado, sin imports sueltos
    assert "widget.js" in cliente.get("/widget/demo").text
