"""Fixtures: base SQLite temporal, LLM con guion y embeddings deterministas (solo en pruebas)."""
import hashlib
import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="platzito_test_")
os.environ.update({
    "DATABASE_URL": os.environ.get("PRUEBAS_DATABASE_URL", f"sqlite:///{_tmp}/test.db"),
    "DIRECTORIO_DATOS": _tmp,
    "PLANIFICADOR_ACTIVO": "false",
    "ENTORNO": "desarrollo",
    "META_APP_SECRET": "secreto-meta",
    "RETELL_API_KEY": "key_retell_prueba",
    "ANTHROPIC_API_KEY": "sk-prueba",
    "URL_PUBLICA": "https://platzito.test",
})

import numpy as np  # noqa: E402
import pytest  # noqa: E402
import respx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import conocimiento, llm  # noqa: E402
from app.db import Base, motor  # noqa: E402
from app.main import app  # noqa: E402


class LLMFalso(llm.Proveedor):
    """Responde según un guion: cada elemento es texto, {"texto","llamadas"} o una función(sistema, mensajes, herr)."""
    guion: list = []
    llamadas_recibidas: list = []

    def __init__(self, modelo="falso", cred=None):
        super().__init__(modelo, cred or {})

    async def stream(self, sistema, mensajes, herramientas=None, temperatura=0.4, max_tokens=1024,
                     forzar_herramienta=None):
        LLMFalso.llamadas_recibidas.append({"sistema": sistema, "mensajes": list(mensajes),
                                            "herramientas": herramientas, "forzar": forzar_herramienta})
        paso = LLMFalso.guion.pop(0) if LLMFalso.guion else "Respuesta por defecto."
        if callable(paso):
            paso = paso(sistema, mensajes, herramientas)
        if isinstance(paso, str):
            paso = {"texto": paso}
        if paso.get("texto"):
            for i in range(0, len(paso["texto"]), 7):
                yield ("texto", paso["texto"][i:i + 7])
        for j, ll in enumerate(paso.get("llamadas", [])):
            yield ("llamada", {"id": ll.get("id", f"t{j}"), "nombre": ll["nombre"], "args": ll.get("args", {})})
        yield ("fin", {"entrada": 100, "salida": 20, "parada": "end"})


async def _embeber_falso(db, espacio_id, textos, es_consulta=False):
    """Bolsa de palabras con hash: textos que comparten palabras quedan cerca."""
    m = np.zeros((len(textos), 64), dtype=np.float32)
    for i, t in enumerate(textos):
        for palabra in t.lower().split():
            m[i, int(hashlib.md5(palabra.strip(".,¿?¡!").encode()).hexdigest(), 16) % 64] += 1
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1
    return m / n, "falso"


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    Base.metadata.drop_all(motor)
    Base.metadata.create_all(motor)
    LLMFalso.guion = []
    LLMFalso.llamadas_recibidas = []
    monkeypatch.setattr(llm, "proveedor", lambda db, espacio_id, nombre=None, modelo=None: LLMFalso())
    monkeypatch.setattr(conocimiento, "embeber", _embeber_falso)
    conocimiento._cache.clear()
    yield


@pytest.fixture(autouse=True)
def red():
    """Ninguna prueba sale a internet: Retell y Meta se simulan; lo no simulado falla."""
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as m:
        m.post("https://api.retellai.com/create-agent").respond(json={"agent_id": "ag_retell_1"})
        m.patch(url__regex=r"https://api\.retellai\.com/update-agent/.*").respond(json={})
        m.get("https://api.retellai.com/list-voices").respond(json=[])
        yield m


@pytest.fixture
def cliente():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sesion(cliente):
    r = cliente.post("/api/auth/registro", json={"nombre": "Ana", "email": "ana@empresa.co", "clave": "clave-segura-1",
                                                 "espacio": "Empresa Demo"})
    assert r.status_code == 200, r.text
    datos = r.json()
    cliente.headers.update({"authorization": f"Bearer {datos['token']}"})
    return datos


@pytest.fixture
def guion():
    return LLMFalso
