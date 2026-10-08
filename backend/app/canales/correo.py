"""Correo saliente por SMTP (paso `correo` de las secuencias y notificaciones)."""
import asyncio
import smtplib
from email.message import EmailMessage
from email.utils import make_msgid

from sqlalchemy.orm import Session

from ..integraciones import credenciales


class ErrorCorreo(Exception):
    pass


def _enviar(cfg: dict, para: str, asunto: str, cuerpo: str, html: str | None) -> str:
    msg = EmailMessage()
    msg["From"] = cfg.get("remitente") or cfg.get("usuario")
    msg["To"] = para
    msg["Subject"] = asunto
    msg["Message-ID"] = make_msgid(domain=(cfg.get("remitente") or "platzito.local").split("@")[-1].strip(">"))
    msg.set_content(cuerpo)
    if html:
        msg.add_alternative(html, subtype="html")
    puerto = int(cfg.get("puerto") or 587)
    clase = smtplib.SMTP_SSL if puerto == 465 else smtplib.SMTP
    with clase(cfg["host"], puerto, timeout=30) as s:
        if puerto != 465:
            s.starttls()
        if cfg.get("usuario"):
            s.login(cfg["usuario"], cfg.get("clave", ""))
        s.send_message(msg)
    return msg["Message-ID"]


async def enviar(db: Session, espacio_id: int, para: str, asunto: str, cuerpo: str, html: str | None = None) -> str:
    cfg = credenciales(db, espacio_id, "smtp")
    if not cfg.get("host"):
        raise ErrorCorreo("SMTP no configurado (Ajustes → Integraciones)")
    try:
        return await asyncio.to_thread(_enviar, cfg, para, asunto, cuerpo, html)
    except (smtplib.SMTPException, OSError) as e:
        raise ErrorCorreo(str(e)) from e
