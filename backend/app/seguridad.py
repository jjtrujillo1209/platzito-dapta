"""Autenticación (JWT y claves de API), RBAC, cifrado de secretos y firmas HMAC."""
import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import timedelta

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import ajustes
from .db import ahora, obtener_db
from .modelos import ROLES, ClaveApi, Espacio, Miembro, Usuario

# ─────────────────────────── Contraseñas y tokens ───────────────────────────


def hash_clave(clave: str) -> str:
    return bcrypt.hashpw(clave.encode(), bcrypt.gensalt()).decode()


def verificar_clave(clave: str, hash_: str) -> bool:
    try:
        return bcrypt.checkpw(clave.encode(), hash_.encode())
    except ValueError:
        return False


def crear_token(usuario_id: int) -> str:
    exp = ahora() + timedelta(minutes=ajustes().minutos_sesion)
    return jwt.encode({"sub": str(usuario_id), "exp": exp}, ajustes().clave_secreta, algorithm="HS256")


def token_aleatorio(n: int = 24) -> str:
    return secrets.token_urlsafe(n)


# ─────────────────────────── Cifrado de secretos en reposo ───────────────────────────


def _fernet() -> Fernet:
    clave = ajustes().clave_cifrado
    if not clave:
        clave = base64.urlsafe_b64encode(hashlib.sha256(ajustes().clave_secreta.encode()).digest()).decode()
    return Fernet(clave.encode())


def cifrar(valor: str | dict) -> str:
    if isinstance(valor, dict):
        valor = json.dumps(valor)
    return _fernet().encrypt(valor.encode()).decode() if valor else ""


def descifrar(valor: str) -> str:
    if not valor:
        return ""
    try:
        return _fernet().decrypt(valor.encode()).decode()
    except InvalidToken:
        return ""


def descifrar_dict(valor: str) -> dict:
    txt = descifrar(valor)
    return json.loads(txt) if txt else {}


# ─────────────────────────── Firmas HMAC ───────────────────────────


def firmar_webhook(secreto: str, cuerpo: bytes, ts: int | None = None) -> str:
    """Encabezado X-Platzito-Firma: t=<unix>,v1=<hex(hmac_sha256(secreto, t.cuerpo))>."""
    ts = ts or int(time.time())
    firma = hmac.new(secreto.encode(), f"{ts}.".encode() + cuerpo, hashlib.sha256).hexdigest()
    return f"t={ts},v1={firma}"


def verificar_firma_meta(app_secret: str, cuerpo: bytes, encabezado: str | None) -> bool:
    if not app_secret or not encabezado or not encabezado.startswith("sha256="):
        return False
    esperado = hmac.new(app_secret.encode(), cuerpo, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, encabezado.removeprefix("sha256="))


def verificar_firma_retell(api_key: str, cuerpo: bytes, encabezado: str | None, tolerancia_s: int = 300) -> bool:
    """x-retell-signature: v=<timestamp_ms>,d=<hex(hmac_sha256(api_key, cuerpo + timestamp))>."""
    if not api_key or not encabezado:
        return False
    try:
        partes = dict(p.split("=", 1) for p in encabezado.split(","))
        ts, digest = partes["v"], partes["d"]
    except (ValueError, KeyError):
        return False
    if abs(time.time() * 1000 - int(ts)) > tolerancia_s * 1000:
        return False
    esperado = hmac.new(api_key.encode(), cuerpo + ts.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, digest)


# ─────────────────────────── Contexto de la petición (RBAC) ───────────────────────────

NIVEL = {rol: len(ROLES) - i for i, rol in enumerate(ROLES)}  # propietario=5 … lector=1


@dataclass
class Contexto:
    db: Session
    espacio: Espacio
    usuario: Usuario | None
    rol: str

    @property
    def espacio_id(self) -> int:
        return self.espacio.id

    def exigir(self, rol_minimo: str):
        if NIVEL[self.rol] < NIVEL[rol_minimo]:
            raise HTTPException(403, f"Se requiere rol {rol_minimo} o superior")


def _usuario_de_jwt(db: Session, token: str) -> Usuario:
    try:
        datos = jwt.decode(token, ajustes().clave_secreta, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Sesión inválida o vencida")
    usuario = db.get(Usuario, int(datos["sub"]))
    if not usuario or not usuario.activo:
        raise HTTPException(401, "Usuario inactivo")
    return usuario


def crear_clave_api() -> tuple[str, str, str]:
    """Devuelve (clave_completa, prefijo, hash). La clave completa solo se muestra una vez."""
    prefijo = "pz_" + secrets.token_hex(4)
    clave = f"{prefijo}_{secrets.token_urlsafe(32)}"
    return clave, prefijo, hashlib.sha256(clave.encode()).hexdigest()


def contexto(
    request: Request,
    db: Session = Depends(obtener_db),
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
    x_espacio: int | None = Header(None),
) -> Contexto:
    bearer = (authorization or "").removeprefix("Bearer ").strip()
    if not x_api_key and bearer.startswith("pz_"):
        x_api_key = bearer  # clientes MCP mandan la clave de API como Bearer
    if x_api_key:
        prefijo = "_".join(x_api_key.split("_")[:2])
        clave = db.scalar(select(ClaveApi).where(ClaveApi.prefijo == prefijo))
        if not clave or not hmac.compare_digest(clave.hash, hashlib.sha256(x_api_key.encode()).hexdigest()):
            raise HTTPException(401, "Clave de API inválida")
        clave.ultimo_uso = ahora()
        db.commit()
        return Contexto(db, db.get(Espacio, clave.espacio_id), None, clave.rol)

    token = bearer  # solo por encabezado: un token en la URL queda en logs, historial y Referer
    if not token:
        raise HTTPException(401, "Falta autenticación")
    usuario = _usuario_de_jwt(db, token)
    consulta = select(Miembro).where(Miembro.usuario_id == usuario.id)
    if x_espacio:
        consulta = consulta.where(Miembro.espacio_id == x_espacio)
    miembro = db.scalars(consulta.order_by(Miembro.id)).first()
    if not miembro:
        raise HTTPException(403, "Sin acceso a este espacio")
    return Contexto(db, db.get(Espacio, miembro.espacio_id), usuario, miembro.rol)


def requiere(rol_minimo: str):
    def _dep(ctx: Contexto = Depends(contexto)) -> Contexto:
        ctx.exigir(rol_minimo)
        return ctx

    return _dep


def usuario_actual(db: Session = Depends(obtener_db), authorization: str | None = Header(None)) -> Usuario:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Falta autenticación")
    return _usuario_de_jwt(db, token)
