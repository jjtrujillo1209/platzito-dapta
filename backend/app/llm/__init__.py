"""Capa LLM intercambiable.

Formato interno de mensajes (independiente del proveedor):
    {"rol": "usuario", "texto": "..."}
    {"rol": "asistente", "texto": "...", "llamadas": [{"id", "nombre", "args"}]}
    {"rol": "herramienta", "id": "...", "nombre": "...", "resultado": "..."}

Herramientas: {"nombre", "descripcion", "parametros": <JSON Schema>}.

Todos los proveedores exponen `stream()` que produce eventos:
    ("texto", str) · ("llamada", {"id","nombre","args"}) · ("fin", {"entrada": int, "salida": int, "parada": str})
"""
import json
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx

from ..integraciones import credenciales
from ..red import UrlNoPermitida, validar_url_externa

# USD por millón de tokens (entrada, salida). Estimación editable; desconocidos cuestan 0.
PRECIOS = {
    "claude-opus-5-5": (5.0, 25.0),
    "claude-sonnet-5-5": (3.0, 15.0),
    "claude-haiku-5-5": (1.0, 5.0),
    "claude-fable-5-1": (3.0, 15.0),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4o-mini": (0.15, 0.6),
    "gpt-4o": (2.5, 10.0),
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "gemini-2.5-flash": (0.3, 2.5),
}

MODELOS_SUGERIDOS = {
    "anthropic": ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    "openai": ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    "groq": ["llama-3.3-70b-versatile"],
    "gemini": ["gemini-2.5-flash"],
    "ollama": ["qwen2.5:7b"],
}


def costo(modelo: str, entrada: int, salida: int) -> float:
    pe, ps = PRECIOS.get(modelo, (0.0, 0.0))
    return round((entrada * pe + salida * ps) / 1_000_000, 6)


class ErrorLLM(Exception):
    pass


@dataclass
class Respuesta:
    texto: str = ""
    llamadas: list[dict] = field(default_factory=list)
    entrada: int = 0
    salida: int = 0
    parada: str = ""


class Proveedor:
    nombre = "base"

    def __init__(self, modelo: str, credenciales_: dict):
        self.modelo = modelo
        self.cred = credenciales_

    async def stream(self, sistema: str, mensajes: list[dict], herramientas: list[dict] | None = None,
                     temperatura: float = 0.4, max_tokens: int = 1024,
                     forzar_herramienta: str | None = None) -> AsyncIterator[tuple]:
        raise NotImplementedError
        yield  # pragma: no cover

    async def completar(self, sistema: str, mensajes: list[dict], herramientas: list[dict] | None = None,
                        temperatura: float = 0.4, max_tokens: int = 1024,
                        forzar_herramienta: str | None = None) -> Respuesta:
        r = Respuesta()
        partes = []
        async for ev in self.stream(sistema, mensajes, herramientas, temperatura, max_tokens, forzar_herramienta):
            if ev[0] == "texto":
                partes.append(ev[1])
            elif ev[0] == "llamada":
                r.llamadas.append(ev[1])
            elif ev[0] == "fin":
                r.entrada, r.salida, r.parada = ev[1]["entrada"], ev[1]["salida"], ev[1].get("parada", "")
        r.texto = "".join(partes)
        return r

    async def json(self, sistema: str, prompt: str, esquema: dict, nombre: str = "responder",
                   temperatura: float = 0.0) -> tuple[dict, Respuesta]:
        """Salida estructurada forzando una herramienta con el esquema pedido."""
        herramienta = {"nombre": nombre, "descripcion": "Entrega la respuesta estructurada.", "parametros": esquema}
        r = await self.completar(sistema, [{"rol": "usuario", "texto": prompt}], [herramienta], temperatura,
                                 max_tokens=2048, forzar_herramienta=nombre)
        if r.llamadas:
            return r.llamadas[0]["args"], r
        # Algunos modelos locales ignoran tool_choice: se intenta leer JSON del texto.
        return _extraer_json(r.texto), r


def _extraer_json(texto: str) -> dict:
    ini, fin = texto.find("{"), texto.rfind("}")
    if ini == -1 or fin <= ini:
        return {}
    try:
        return json.loads(texto[ini:fin + 1])
    except json.JSONDecodeError:
        return {}


async def _lineas_sse(resp: httpx.Response) -> AsyncIterator[str]:
    async for linea in resp.aiter_lines():
        if linea.startswith("data:"):
            yield linea[5:].strip()


# ─────────────────────────────── Anthropic ───────────────────────────────

class Anthropic(Proveedor):
    nombre = "anthropic"
    URL = "https://api.anthropic.com/v1/messages"

    @staticmethod
    def _mensajes(mensajes: list[dict]) -> list[dict]:
        salida: list[dict] = []
        for m in mensajes:
            if m["rol"] == "usuario":
                bloque = {"role": "user", "content": [{"type": "text", "text": m["texto"] or "…"}]}
            elif m["rol"] == "asistente":
                contenido = []
                if m.get("texto"):
                    contenido.append({"type": "text", "text": m["texto"]})
                for ll in m.get("llamadas", []):
                    contenido.append({"type": "tool_use", "id": ll["id"], "name": ll["nombre"], "input": ll["args"]})
                if not contenido:
                    continue
                bloque = {"role": "assistant", "content": contenido}
            else:
                bloque = {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": m["id"], "content": str(m["resultado"])}]}
            if salida and salida[-1]["role"] == bloque["role"]:
                salida[-1]["content"].extend(bloque["content"])
            else:
                salida.append(bloque)
        if salida and salida[0]["role"] != "user":
            salida.insert(0, {"role": "user", "content": [{"type": "text", "text": "(inicio de la conversación)"}]})
        return salida

    async def stream(self, sistema, mensajes, herramientas=None, temperatura=0.4, max_tokens=1024,
                     forzar_herramienta=None):
        if not self.cred.get("api_key"):
            raise ErrorLLM("Falta la API key de Anthropic (Ajustes → Integraciones)")
        cuerpo = {"model": self.modelo, "max_tokens": max_tokens, "temperature": temperatura, "stream": True,
                  "system": sistema, "messages": self._mensajes(mensajes)}
        if herramientas:
            cuerpo["tools"] = [{"name": h["nombre"], "description": h["descripcion"],
                                "input_schema": h["parametros"]} for h in herramientas]
            if forzar_herramienta:
                cuerpo["tool_choice"] = {"type": "tool", "name": forzar_herramienta}
        cab = {"x-api-key": self.cred["api_key"], "anthropic-version": "2023-06-01",
               "content-type": "application/json"}
        entrada = salida = 0
        parada = ""
        bloques: dict[int, dict] = {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as cliente:
            async with cliente.stream("POST", self.URL, json=cuerpo, headers=cab) as resp:
                if resp.status_code >= 400:
                    raise ErrorLLM(f"Anthropic {resp.status_code}: {(await resp.aread()).decode()[:300]}")
                async for dato in _lineas_sse(resp):
                    ev = json.loads(dato)
                    t = ev.get("type")
                    if t == "message_start":
                        entrada = ev["message"]["usage"].get("input_tokens", 0)
                    elif t == "content_block_start":
                        b = ev["content_block"]
                        bloques[ev["index"]] = {"tipo": b["type"], "id": b.get("id"), "nombre": b.get("name"),
                                                "json": ""}
                    elif t == "content_block_delta":
                        d = ev["delta"]
                        if d["type"] == "text_delta":
                            yield ("texto", d["text"])
                        elif d["type"] == "input_json_delta":
                            bloques[ev["index"]]["json"] += d["partial_json"]
                    elif t == "content_block_stop":
                        b = bloques.get(ev["index"])
                        if b and b["tipo"] == "tool_use":
                            yield ("llamada", {"id": b["id"], "nombre": b["nombre"],
                                               "args": json.loads(b["json"] or "{}")})
                    elif t == "message_delta":
                        salida = ev.get("usage", {}).get("output_tokens", salida)
                        parada = ev.get("delta", {}).get("stop_reason") or parada
                    elif t == "error":
                        raise ErrorLLM(f"Anthropic: {ev.get('error')}")
        yield ("fin", {"entrada": entrada, "salida": salida, "parada": parada})


# ─────────────────────── Compatibles con OpenAI (OpenAI, Groq, Gemini, Ollama) ───────────────────────

class CompatibleOpenAI(Proveedor):
    nombre = "openai"

    def __init__(self, modelo, credenciales_, base_url: str, requiere_key: bool = True):
        super().__init__(modelo, credenciales_)
        self.base_url = base_url.rstrip("/")
        self.requiere_key = requiere_key

    @staticmethod
    def _mensajes(sistema: str, mensajes: list[dict]) -> list[dict]:
        salida = [{"role": "system", "content": sistema}]
        for m in mensajes:
            if m["rol"] == "usuario":
                salida.append({"role": "user", "content": m["texto"]})
            elif m["rol"] == "asistente":
                b = {"role": "assistant", "content": m.get("texto") or ""}
                if m.get("llamadas"):
                    b["tool_calls"] = [{"id": ll["id"], "type": "function", "function": {
                        "name": ll["nombre"], "arguments": json.dumps(ll["args"], ensure_ascii=False)}}
                        for ll in m["llamadas"]]
                salida.append(b)
            else:
                salida.append({"role": "tool", "tool_call_id": m["id"], "content": str(m["resultado"])})
        return salida

    async def stream(self, sistema, mensajes, herramientas=None, temperatura=0.4, max_tokens=1024,
                     forzar_herramienta=None):
        if self.requiere_key and not self.cred.get("api_key"):
            raise ErrorLLM(f"Falta la API key de {self.nombre} (Ajustes → Integraciones)")
        cuerpo = {"model": self.modelo, "messages": self._mensajes(sistema, mensajes), "temperature": temperatura,
                  "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True}}
        if herramientas:
            cuerpo["tools"] = [{"type": "function", "function": {
                "name": h["nombre"], "description": h["descripcion"], "parameters": h["parametros"]}}
                for h in herramientas]
            if forzar_herramienta:
                cuerpo["tool_choice"] = {"type": "function", "function": {"name": forzar_herramienta}}
        cab = {"content-type": "application/json"}
        if self.cred.get("api_key"):
            cab["authorization"] = f"Bearer {self.cred['api_key']}"
        entrada = salida = 0
        parada = ""
        acumuladas: dict[int, dict] = {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10)) as cliente:
            async with cliente.stream("POST", f"{self.base_url}/chat/completions", json=cuerpo, headers=cab) as resp:
                if resp.status_code >= 400:
                    raise ErrorLLM(f"{self.nombre} {resp.status_code}: {(await resp.aread()).decode()[:300]}")
                async for dato in _lineas_sse(resp):
                    if dato == "[DONE]":
                        break
                    ev = json.loads(dato)
                    if ev.get("usage"):
                        entrada = ev["usage"].get("prompt_tokens", entrada)
                        salida = ev["usage"].get("completion_tokens", salida)
                    for opcion in ev.get("choices", []):
                        d = opcion.get("delta", {})
                        if d.get("content"):
                            yield ("texto", d["content"])
                        for tc in d.get("tool_calls") or []:
                            a = acumuladas.setdefault(tc.get("index", 0), {"id": None, "nombre": "", "args": ""})
                            a["id"] = tc.get("id") or a["id"]
                            f = tc.get("function", {})
                            a["nombre"] += f.get("name") or ""
                            a["args"] += f.get("arguments") or ""
                        if opcion.get("finish_reason"):
                            parada = opcion["finish_reason"]
        for i, a in sorted(acumuladas.items()):
            try:
                args = json.loads(a["args"] or "{}")
            except json.JSONDecodeError:
                args = {}
            yield ("llamada", {"id": a["id"] or f"call_{i}", "nombre": a["nombre"], "args": args})
        yield ("fin", {"entrada": entrada, "salida": salida, "parada": parada})


def proveedor(db, espacio_id: int | None, nombre: str | None = None, modelo: str | None = None) -> Proveedor:
    from ..config import ajustes

    nombre = nombre or ajustes().llm_proveedor
    modelo = modelo or ajustes().llm_modelo
    cred = credenciales(db, espacio_id, nombre)

    def externa(url: str) -> str:
        """URLs escritas por el espacio no son de confianza (SSRF); la ollama_url del .env sí."""
        try:
            return validar_url_externa(url)
        except UrlNoPermitida as e:
            raise ErrorLLM(f"URL del proveedor {nombre} no permitida: {e}") from e

    if nombre == "anthropic":
        return Anthropic(modelo, cred)
    if nombre == "openai":
        p = CompatibleOpenAI(modelo, cred, externa(cred["base_url"]) if cred.get("base_url")
                             else "https://api.openai.com/v1")
    elif nombre == "groq":
        p = CompatibleOpenAI(modelo, cred, "https://api.groq.com/openai/v1")
    elif nombre == "gemini":
        p = CompatibleOpenAI(modelo, cred, "https://generativelanguage.googleapis.com/v1beta/openai")
    elif nombre == "ollama":
        de_confianza = (ajustes().ollama_url or "http://localhost:11434").rstrip("/")
        url = (cred.get("url") or de_confianza).rstrip("/")
        if url != de_confianza:
            externa(url)
        p = CompatibleOpenAI(modelo, cred, f"{url}/v1", requiere_key=False)
    else:
        raise ErrorLLM(f"Proveedor LLM desconocido: {nombre}")
    p.nombre = nombre
    return p
