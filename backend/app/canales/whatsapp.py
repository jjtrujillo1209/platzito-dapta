"""Cliente de WhatsApp Cloud API (Meta directo, sin BSP) y Embedded Signup."""
import re

import httpx

from ..config import ajustes
from ..modelos import LineaWhatsapp
from ..seguridad import descifrar


class ErrorWhatsapp(Exception):
    def __init__(self, mensaje: str, codigo: int | None = None, transitorio: bool = False):
        super().__init__(mensaje)
        self.codigo = codigo
        self.transitorio = transitorio


# Códigos de Meta que vale la pena reintentar o que indican límite de velocidad
TRANSITORIOS = {1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056}
FUERA_DE_VENTANA = 131047


def _base() -> str:
    return f"https://graph.facebook.com/{ajustes().meta_graph_version}"


async def _llamar(metodo: str, ruta: str, token: str, **kw) -> dict:
    async with httpx.AsyncClient(timeout=30) as cliente:
        r = await cliente.request(metodo, f"{_base()}/{ruta.lstrip('/')}",
                                  headers={"authorization": f"Bearer {token}"}, **kw)
    datos = r.json() if r.content else {}
    if r.status_code >= 400 or "error" in datos:
        err = datos.get("error", {})
        codigo = err.get("code")
        raise ErrorWhatsapp(f"Meta {r.status_code}: {err.get('message', r.text[:300])}", codigo,
                            transitorio=codigo in TRANSITORIOS or r.status_code >= 500)
    return datos


def _token(linea: LineaWhatsapp) -> str:
    token = descifrar(linea.token_cifrado)
    if not token:
        raise ErrorWhatsapp("La línea no tiene token de acceso")
    return token


def solo_digitos(numero: str) -> str:
    return re.sub(r"\D", "", numero or "")


async def enviar_texto(linea: LineaWhatsapp, para: str, texto: str, responder_a: str | None = None) -> str:
    cuerpo = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": solo_digitos(para),
              "type": "text", "text": {"body": texto[:4096], "preview_url": True}}
    if responder_a:
        cuerpo["context"] = {"message_id": responder_a}
    datos = await _llamar("POST", f"{linea.phone_number_id}/messages", _token(linea), json=cuerpo)
    return datos["messages"][0]["id"]


def componentes_plantilla(variables: list[str], encabezado: dict | None = None) -> list[dict]:
    comps = []
    if encabezado:
        comps.append({"type": "header", "parameters": [encabezado]})
    if variables:
        comps.append({"type": "body", "parameters": [{"type": "text", "text": str(v)[:1024]} for v in variables]})
    return comps


async def enviar_plantilla(linea: LineaWhatsapp, para: str, nombre: str, idioma: str,
                           variables: list[str] | None = None) -> str:
    cuerpo = {"messaging_product": "whatsapp", "to": solo_digitos(para), "type": "template",
              "template": {"name": nombre, "language": {"code": idioma},
                           "components": componentes_plantilla(variables or [])}}
    datos = await _llamar("POST", f"{linea.phone_number_id}/messages", _token(linea), json=cuerpo)
    return datos["messages"][0]["id"]


async def marcar_leido_y_escribiendo(linea: LineaWhatsapp, wamid: str):
    """Marca leído y muestra el indicador "escribiendo…" (se apaga al responder o a los 25 s)."""
    try:
        await _llamar("POST", f"{linea.phone_number_id}/messages", _token(linea), json={
            "messaging_product": "whatsapp", "status": "read", "message_id": wamid,
            "typing_indicator": {"type": "text"}})
    except ErrorWhatsapp:
        pass  # cosmético: nunca debe tumbar la respuesta


async def estado_linea(linea: LineaWhatsapp) -> dict:
    return await _llamar("GET", linea.phone_number_id, _token(linea), params={
        "fields": "display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status"})


async def listar_plantillas(linea: LineaWhatsapp) -> list[dict]:
    salida, despues = [], None
    while True:
        params = {"limit": 100, "fields": "id,name,language,status,category,components,rejected_reason"}
        if despues:
            params["after"] = despues
        datos = await _llamar("GET", f"{linea.waba_id}/message_templates", _token(linea), params=params)
        salida += datos.get("data", [])
        despues = datos.get("paging", {}).get("cursors", {}).get("after")
        if not despues or not datos.get("paging", {}).get("next"):
            return salida


async def crear_plantilla(linea: LineaWhatsapp, nombre: str, idioma: str, categoria: str, cuerpo: str,
                          ejemplos: list[str], encabezado: str = "", pie: str = "", botones: list[dict] | None = None
                          ) -> dict:
    comps: list[dict] = []
    if encabezado:
        comps.append({"type": "HEADER", "format": "TEXT", "text": encabezado})
    body = {"type": "BODY", "text": cuerpo}
    if ejemplos:
        body["example"] = {"body_text": [ejemplos]}
    comps.append(body)
    if pie:
        comps.append({"type": "FOOTER", "text": pie})
    if botones:
        comps.append({"type": "BUTTONS", "buttons": botones})
    return await _llamar("POST", f"{linea.waba_id}/message_templates", _token(linea), json={
        "name": nombre, "language": idioma, "category": categoria, "components": comps})


# ─────────────────────────────── Embedded Signup ───────────────────────────────

async def canjear_codigo(app_id: str, app_secret: str, codigo: str) -> str:
    async with httpx.AsyncClient(timeout=30) as cliente:
        r = await cliente.get(f"{_base()}/oauth/access_token", params={
            "client_id": app_id, "client_secret": app_secret, "code": codigo})
    datos = r.json()
    if "access_token" not in datos:
        raise ErrorWhatsapp(f"No se pudo canjear el código: {datos.get('error', {}).get('message', r.text[:200])}")
    return datos["access_token"]


async def suscribir_app(waba_id: str, token: str):
    await _llamar("POST", f"{waba_id}/subscribed_apps", token)


async def registrar_numero(phone_number_id: str, token: str, pin: str):
    await _llamar("POST", f"{phone_number_id}/register", token, json={"messaging_product": "whatsapp", "pin": pin})


async def info_numero(phone_number_id: str, token: str) -> dict:
    return await _llamar("GET", phone_number_id, token, params={
        "fields": "display_phone_number,verified_name,quality_rating,messaging_limit_tier"})


def variables_de_cuerpo(cuerpo: str) -> int:
    return len(set(re.findall(r"\{\{(\d+)\}\}", cuerpo or "")))
