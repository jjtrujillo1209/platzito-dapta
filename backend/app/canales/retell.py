"""Cliente de Retell AI. Retell pone STT, TTS, turnos y telefonía; el cerebro es nuestro
(Custom LLM por WebSocket), así texto y voz comparten prompt, herramientas y guardas."""
import hashlib
import hmac

import httpx

from ..config import ajustes

BASE = "https://api.retellai.com"


class ErrorRetell(Exception):
    pass


async def _llamar(api_key: str, metodo: str, ruta: str, **kw) -> dict:
    if not api_key:
        raise ErrorRetell("Falta la API key de Retell (Ajustes → Integraciones)")
    async with httpx.AsyncClient(timeout=30) as cliente:
        r = await cliente.request(metodo, f"{BASE}{ruta}", headers={"authorization": f"Bearer {api_key}"}, **kw)
    if r.status_code >= 400:
        raise ErrorRetell(f"Retell {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def firma_ws(agente_id: int) -> str:
    """Firma del WebSocket de voz: sin ella cualquiera podría conversar con el agente y leer su contexto."""
    return hmac.new(ajustes().clave_secreta.encode(), f"voz-ws:{agente_id}".encode(), hashlib.sha256).hexdigest()[:40]


def url_ws(agente_id: int) -> str:
    base = ajustes().url_publica.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/voz/llm/{agente_id}/{firma_ws(agente_id)}"  # Retell agrega /{call_id}


def url_webhook() -> str:
    return f"{ajustes().url_publica}/webhooks/retell"


def cuerpo_agente(agente_id: int, nombre: str, cfg: dict) -> dict:
    v = cfg["voz"]
    cuerpo = {
        "agent_name": nombre[:100],
        "response_engine": {"type": "custom-llm", "llm_websocket_url": url_ws(agente_id)},
        "voice_id": v["voz_id"],
        "voice_speed": v["velocidad"],
        "voice_temperature": v["temperatura_voz"],
        "volume": v["volumen"],
        "language": v["idioma"],
        "responsiveness": v["reactividad"],
        "interruption_sensitivity": v["sensibilidad_interrupcion"],
        "enable_backchannel": v["backchannel"],
        "boosted_keywords": v["palabras_clave"],
        "normalize_for_speech": True,
        "end_call_after_silence_ms": v["fin_silencio_ms"],
        "max_call_duration_ms": v["duracion_max_ms"],
        "reminder_trigger_ms": v["recordatorio_ms"],
        "reminder_max_count": v["recordatorio_max"],
        "allow_user_dtmf": v["dtmf"],
        "webhook_url": url_webhook(),
    }
    if v.get("sonido_ambiente"):
        cuerpo["ambient_sound"] = v["sonido_ambiente"]
    b = v["buzon"]
    if b["detectar"]:
        accion = ({"type": "static_text", "text": b["mensaje"]} if b["accion"] == "mensaje" and b["mensaje"]
                  else {"type": "hangup"})
        cuerpo["voicemail_option"] = {"action": accion}
    return cuerpo


async def sincronizar_agente(api_key: str, agente_id: int, nombre: str, cfg: dict, retell_id: str | None) -> str:
    cuerpo = cuerpo_agente(agente_id, nombre, cfg)
    if retell_id:
        try:
            await _llamar(api_key, "PATCH", f"/update-agent/{retell_id}", json=cuerpo)
            return retell_id
        except ErrorRetell as e:
            if "404" not in str(e):
                raise
    datos = await _llamar(api_key, "POST", "/create-agent", json=cuerpo)
    return datos["agent_id"]


async def crear_llamada(api_key: str, retell_agent_id: str, desde: str, hacia: str, variables: dict,
                        metadatos: dict) -> dict:
    return await _llamar(api_key, "POST", "/v2/create-phone-call", json={
        "from_number": desde, "to_number": hacia, "override_agent_id": retell_agent_id,
        "retell_llm_dynamic_variables": {k: str(v) for k, v in variables.items()}, "metadata": metadatos})


async def crear_llamada_web(api_key: str, retell_agent_id: str, variables: dict, metadatos: dict) -> dict:
    return await _llamar(api_key, "POST", "/v2/create-web-call", json={
        "agent_id": retell_agent_id, "retell_llm_dynamic_variables": {k: str(v) for k, v in variables.items()},
        "metadata": metadatos})


async def importar_numero(api_key: str, numero: str, termination_uri: str, usuario: str, clave: str,
                          agente_entrante: str | None, agente_saliente: str | None, apodo: str = "") -> dict:
    cuerpo = {"phone_number": numero, "termination_uri": termination_uri, "nickname": apodo[:50]}
    if usuario:
        cuerpo |= {"sip_trunk_auth_username": usuario, "sip_trunk_auth_password": clave}
    if agente_entrante:
        cuerpo["inbound_agent_id"] = agente_entrante
    if agente_saliente:
        cuerpo["outbound_agent_id"] = agente_saliente
    return await _llamar(api_key, "POST", "/import-phone-number", json=cuerpo)


async def actualizar_numero(api_key: str, numero: str, agente_entrante: str | None, agente_saliente: str | None):
    return await _llamar(api_key, "PATCH", f"/update-phone-number/{numero}", json={
        "inbound_agent_id": agente_entrante, "outbound_agent_id": agente_saliente})


async def listar_voces(api_key: str) -> list[dict]:
    datos = await _llamar(api_key, "GET", "/list-voices")
    return datos if isinstance(datos, list) else datos.get("voices", [])


async def obtener_llamada(api_key: str, call_id: str) -> dict:
    return await _llamar(api_key, "GET", f"/v2/get-call/{call_id}")


async def borrar_agente(api_key: str, retell_id: str):
    try:
        await _llamar(api_key, "DELETE", f"/delete-agent/{retell_id}")
    except ErrorRetell:
        pass


# Retell → resultado normalizado
RESULTADO_POR_RAZON = {
    "dial_no_answer": "no_contesta", "dial_busy": "ocupado", "dial_failed": "fallida",
    "voicemail_reached": "buzon", "invalid_destination": "fallida", "telephony_provider_permission_denied":
    "fallida", "telephony_provider_unavailable": "fallida", "sip_routing_error": "fallida",
    "marked_as_spam": "fallida", "user_declined": "no_contesta", "error_no_audio_received": "fallida",
    "concurrency_limit_reached": "fallida", "no_valid_payment": "fallida", "scam_detected": "fallida",
    "error_unknown_method": "fallida", "error_user_not_joined": "fallida",
}


def resultado_de(razon: str, duracion_s: int) -> str:
    if razon in RESULTADO_POR_RAZON:
        return RESULTADO_POR_RAZON[razon]
    if razon.startswith("error"):
        return "fallida"
    return "contestada" if duracion_s > 0 else "no_contesta"
