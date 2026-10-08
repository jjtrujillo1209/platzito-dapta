"""Auth, RBAC, agentes (borrador/publicar/rollback), playground, guardas y conocimiento."""
import pytest

from app.cerebro.motor import PIDE_HUMANO, FiltroTexto
from app.conocimiento import fragmentar


def test_registro_login_y_yo(cliente, sesion):
    assert sesion["espacios"][0]["rol"] == "propietario"
    r = cliente.post("/api/auth/login", json={"email": "ana@empresa.co", "clave": "mala-clave-x"})
    assert r.status_code == 401
    r = cliente.post("/api/auth/login", json={"email": "ANA@empresa.co", "clave": "clave-segura-1"})
    assert r.status_code == 200
    assert cliente.get("/api/auth/yo").json()["usuario"]["email"] == "ana@empresa.co"


def test_rbac_invitacion_lector_no_edita(cliente, sesion):
    inv = cliente.post("/api/invitaciones", json={"email": "luis@empresa.co", "rol": "lector"}).json()
    otro = cliente.post(f"/api/invitaciones/{inv['token']}/aceptar", json={"nombre": "Luis", "clave": "otra-clave-1"})
    assert otro.status_code == 200
    h = {"authorization": f"Bearer {otro.json()['token']}"}
    assert cliente.get("/api/agentes", headers=h).status_code == 200
    assert cliente.post("/api/agentes", json={"nombre": "X"}, headers=h).status_code == 403


def test_agente_borrador_publicar_rollback(cliente, sesion):
    a = cliente.post("/api/agentes", json={"nombre": "Ventas"}).json()
    cfg = a["config"]
    cfg["instrucciones"] = "Versión 1"
    cliente.patch(f"/api/agentes/{a['id']}", json={"config": cfg})
    r = cliente.post(f"/api/agentes/{a['id']}/publicar", json={"nota": "primera"})
    assert r.status_code == 200
    # El mock de Retell no existe: la publicación debe avisar, no fallar
    assert r.json()["version_publicada"] == 1
    cfg["instrucciones"] = "Versión 2"
    cliente.patch(f"/api/agentes/{a['id']}", json={"config": cfg})
    assert cliente.get(f"/api/agentes/{a['id']}").json()["cambios_sin_publicar"] is True
    cliente.post(f"/api/agentes/{a['id']}/publicar", json={})
    r = cliente.post(f"/api/agentes/{a['id']}/versiones/1/restaurar")
    assert r.json()["config_publicada"]["instrucciones"] == "Versión 1"
    assert r.json()["version_publicada"] == 3
    assert len(cliente.get(f"/api/agentes/{a['id']}/versiones").json()) == 3


def test_config_invalida_rechazada(cliente, sesion):
    a = cliente.post("/api/agentes", json={"nombre": "X"}).json()
    r = cliente.patch(f"/api/agentes/{a['id']}", json={"config": {"modelo": {"temperatura": 9}}})
    assert r.status_code == 422


def test_playground_con_herramienta_de_conocimiento(cliente, sesion, guion):
    c = cliente.post("/api/cerebros", json={"nombre": "Base"}).json()
    f = cliente.post(f"/api/cerebros/{c['id']}/fuentes", json={
        "tipo": "texto", "nombre": "Precios", "texto": "El plan Pro cuesta 49 dólares al mes e incluye soporte."})
    assert f.status_code == 200
    import asyncio

    from app import conocimiento
    from app.db import FabricaSesion

    db = FabricaSesion()
    asyncio.run(conocimiento.procesar_fuente(db, f.json()["id"]))
    db.close()
    assert cliente.get(f"/api/cerebros/{c['id']}").json()["fuentes"][0]["estado"] == "lista"

    a = cliente.post("/api/agentes", json={"nombre": "Soporte"}).json()
    cfg = a["config"]
    cfg["conocimiento"]["cerebro_ids"] = [c["id"]]
    cliente.patch(f"/api/agentes/{a['id']}", json={"config": cfg})
    guion.guion = [
        {"texto": "Déjame revisar.", "llamadas": [{"nombre": "buscar_conocimiento",
                                                   "args": {"consulta": "cuánto cuesta el plan pro"}}]},
        "El plan Pro cuesta 49 dólares al mes.",
    ]
    r = cliente.post(f"/api/agentes/{a['id']}/playground", json={"texto": "¿Cuánto cuesta el plan Pro?"})
    assert r.status_code == 200, r.text
    mensajes = r.json()["mensajes"]
    herramienta = next(m for m in mensajes if m["tipo"] == "herramienta")
    assert "49 dólares" in herramienta["datos"]["resultados"][0]["resultado"]
    assert mensajes[-1]["contenido"] == "El plan Pro cuesta 49 dólares al mes."
    # La segunda ronda recibió el resultado de la herramienta
    segunda = guion.llamadas_recibidas[1]["mensajes"]
    assert segunda[-1]["rol"] == "herramienta"
    assert r.json()["costo_usd"] >= 0


def test_guarda_escala_si_pide_humano(cliente, sesion, guion):
    a = cliente.post("/api/agentes", json={"nombre": "X"}).json()
    guion.guion = ["Claro, te ayudo yo mismo."]  # el modelo NO escala
    r = cliente.post(f"/api/agentes/{a['id']}/playground", json={"texto": "Quiero hablar con una persona real"})
    assert r.json()["escalado"] is True


def test_filtro_texto_descarta_herramientas_escritas():
    f = FiltroTexto()
    salida = f.alimentar('Claro. {"name": "buscar_conocimiento", "arguments": {}} ') + f.vaciar()
    assert "buscar_conocimiento" not in salida and salida.startswith("Claro.")
    f = FiltroTexto()
    assert f.alimentar("Hola, ¿cómo estás? ") + f.vaciar() == "Hola, ¿cómo estás? "


@pytest.mark.parametrize("texto,esperado", [
    ("quiero hablar con un humano", True), ("me pasas con un asesor?", True),
    ("necesito una persona real", True), ("quiero el plan humano", False), ("hola", False)])
def test_pide_humano(texto, esperado):
    assert bool(PIDE_HUMANO.search(texto)) is esperado


def test_fragmentar_respeta_tamano():
    texto = "\n\n".join(f"Párrafo {i}. " + "palabra " * 120 for i in range(20))
    frags = fragmentar(texto, 3200, 400)
    assert len(frags) > 3 and all(len(f) <= 3600 for f in frags)


def test_simulador_usa_escenarios_por_defecto_si_el_modelo_no_genera(cliente, sesion, guion):
    """Modelos locales a veces devuelven {"escenarios": []}: igual se simula con escenarios por defecto."""
    import asyncio

    from app import simulador
    from app.db import FabricaSesion
    from app.modelos import Simulacion

    a = cliente.post("/api/agentes", json={"nombre": "Sim"}).json()
    guion.guion = [{"llamadas": [{"nombre": "responder", "args": {"escenarios": []}}]}]
    r = cliente.post(f"/api/agentes/{a['id']}/simulaciones", json={"n_escenarios": 2, "max_turnos": 2})
    assert r.status_code == 200, r.text
    assert [e["comportamiento"] for e in r.json()["escenarios"]] == ["cooperativo", "escéptico"]
    # Corriendo una simulación sin escenarios guardados: el generador vuelve a fallar y se usan los de defecto
    db = FabricaSesion()
    sim = Simulacion(espacio_id=sesion["espacios"][0]["id"], agente_id=a["id"], nombre="s", escenarios=[],
                     max_turnos=2)
    db.add(sim)
    db.commit()
    guion.guion = [{"llamadas": [{"nombre": "responder", "args": {"escenarios": []}}]}]
    asyncio.run(simulador.correr(db, sim.id))
    db.refresh(sim)
    assert sim.estado == "lista" and len(sim.escenarios) == 5 and sim.error == ""
    db.close()
