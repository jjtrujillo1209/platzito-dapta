"""Resolución de credenciales por espacio: primero la integración guardada, luego el .env."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import ajustes
from .modelos import Integracion
from .seguridad import cifrar, descifrar_dict

# Campos que acepta cada integración y su respaldo en el .env
CAMPOS = {
    "anthropic": {"api_key": "anthropic_api_key"},
    "openai": {"api_key": "openai_api_key", "base_url": None},
    "groq": {"api_key": "groq_api_key"},
    "gemini": {"api_key": "gemini_api_key"},
    "ollama": {"url": "ollama_url"},
    "retell": {"api_key": "retell_api_key"},
    "meta": {"app_id": "meta_app_id", "app_secret": "meta_app_secret", "config_id": "meta_config_id"},
    "smtp": {"host": "smtp_host", "puerto": "smtp_puerto", "usuario": "smtp_usuario", "clave": "smtp_clave",
             "remitente": "smtp_remitente"},
    "calcom": {"api_key": None, "event_type_id": None},
    "hubspot": {"token": None},
}
SECRETOS = {"api_key", "app_secret", "clave", "token"}


def credenciales(db: Session | None, espacio_id: int | None, tipo: str) -> dict:
    datos: dict = {}
    if db is not None and espacio_id:
        fila = db.scalar(select(Integracion).where(Integracion.espacio_id == espacio_id, Integracion.tipo == tipo,
                                                   Integracion.activa.is_(True)))
        if fila:
            datos = descifrar_dict(fila.config_cifrada)
    a = ajustes()
    for campo, var in CAMPOS.get(tipo, {}).items():
        if not datos.get(campo) and var:
            datos[campo] = getattr(a, var)
    return datos


def guardar(db: Session, espacio_id: int, tipo: str, valores: dict) -> Integracion:
    from fastapi import HTTPException

    from .red import UrlNoPermitida, validar_url_externa

    campo_url = {"openai": "base_url", "ollama": "url"}.get(tipo)
    if campo_url and valores.get(campo_url):
        try:
            validar_url_externa(str(valores[campo_url]))
        except UrlNoPermitida as e:
            raise HTTPException(422, str(e))
    fila = db.scalar(select(Integracion).where(Integracion.espacio_id == espacio_id, Integracion.tipo == tipo))
    actuales = descifrar_dict(fila.config_cifrada) if fila else {}
    for k, v in valores.items():
        if k not in CAMPOS.get(tipo, {}):
            continue
        if k in SECRETOS and (v is None or v == "" or str(v).startswith("••")):
            continue  # no pisar un secreto con el valor enmascarado
        actuales[k] = v
    if not fila:
        fila = Integracion(espacio_id=espacio_id, tipo=tipo)
        db.add(fila)
    fila.config_cifrada = cifrar(actuales)
    fila.activa = True
    db.commit()
    return fila


def vista_publica(db: Session, espacio_id: int) -> list[dict]:
    """Estado de cada integración sin exponer secretos."""
    salida = []
    for tipo, campos in CAMPOS.items():
        datos = credenciales(db, espacio_id, tipo)
        guardada = db.scalar(select(Integracion).where(Integracion.espacio_id == espacio_id, Integracion.tipo == tipo))
        valores = {}
        for campo in campos:
            v = datos.get(campo)
            if campo in SECRETOS and v:
                valores[campo] = "••••" + str(v)[-4:]
            else:
                valores[campo] = v
        principal = next(iter(campos))
        salida.append({"tipo": tipo, "configurada": bool(datos.get(principal)), "origen": "espacio" if guardada else
                       ("instancia" if datos.get(principal) else None), "valores": valores})
    return salida
