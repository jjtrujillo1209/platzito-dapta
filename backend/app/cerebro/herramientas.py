"""Herramientas que el agente puede usar en cualquier canal (texto y voz).

Cada herramienta configurada se traduce a una o más definiciones para el LLM
y se ejecuta aquí. Las que cambian el curso de la llamada (colgar, transferir,
escalar) devuelven una *acción* que el canal aplica.
"""
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime

import httpx
from sqlalchemy.orm import Session

from .. import conocimiento
from ..eventos import emitir
from ..modelos import Agente, Contacto, Conversacion, LineaWhatsapp, Plantilla
from ..red import UrlNoPermitida, validar_url_externa
from . import agenda

TIPOS_JSON = {"texto": "string", "numero": "number", "booleano": "boolean", "fecha": "string", "email": "string",
              "telefono": "string", "enum": "string"}
SOLO_VOZ = {"colgar", "transferir_llamada"}


@dataclass
class ContextoTurno:
    db: Session
    espacio_id: int
    agente: Agente | None
    config: dict
    canal: str
    conversacion: Conversacion | None = None
    contacto: Contacto | None = None
    variables: dict = field(default_factory=dict)
    zona: str = "America/Bogota"
    acciones: list[dict] = field(default_factory=list)
    fuentes: list[dict] = field(default_factory=list)
    simulado: bool = False  # simulador/playground: no hay efectos externos

    def accion(self, tipo: str, **datos):
        self.acciones.append({"tipo": tipo, **datos})


def _esquema(parametros: list[dict]) -> dict:
    props, req = {}, []
    for p in parametros:
        prop = {"type": TIPOS_JSON[p["tipo"]], "description": p.get("descripcion", "")}
        if p["tipo"] == "enum" and p.get("opciones"):
            prop["enum"] = p["opciones"]
        if p["tipo"] == "fecha":
            prop["description"] += " (formato ISO 8601)"
        props[p["nombre"]] = prop
        if p.get("requerido", True):
            req.append(p["nombre"])
    return {"type": "object", "properties": props, "required": req}


def definiciones(config: dict, canal: str) -> list[dict]:
    """Herramientas visibles para el LLM según la configuración y el canal."""
    salida = []
    for h in config.get("herramientas", []):
        if not h.get("activa", True):
            continue
        t = h["tipo"]
        if t in SOLO_VOZ and canal != "voz":
            continue
        nombre = h.get("nombre") or t
        desc = h.get("descripcion", "")
        if t == "buscar_conocimiento":
            if not config.get("conocimiento", {}).get("cerebro_ids"):
                continue
            salida.append({"nombre": nombre, "descripcion": desc or (
                "Busca en la base de conocimiento de la empresa. Úsala antes de responder sobre productos, precios, "
                "políticas o datos que no estén en tus instrucciones. Nunca inventes esos datos."),
                "parametros": {"type": "object", "properties": {"consulta": {
                    "type": "string", "description": "Pregunta concreta a buscar"}}, "required": ["consulta"]}})
        elif t == "agendar_cita":
            salida.append({"nombre": "consultar_disponibilidad", "descripcion":
                           "Consulta los horarios libres para agendar a partir de una fecha.",
                           "parametros": {"type": "object", "properties": {"desde": {
                               "type": "string", "description": "Fecha AAAA-MM-DD; por defecto hoy"}}}})
            salida.append({"nombre": nombre if nombre != t else "agendar_cita", "descripcion": desc or (
                "Agenda una cita en uno de los horarios libres. Confirma fecha y hora con el contacto antes."),
                "parametros": {"type": "object", "properties": {
                    "inicio": {"type": "string", "description": "Fecha y hora local ISO 8601, p. ej. 2026-10-09T15:00"},
                    "email": {"type": "string", "description": "Correo del contacto si lo dio"},
                    "notas": {"type": "string", "description": "Motivo o contexto de la cita"}},
                    "required": ["inicio"]}})
        elif t == "enviar_plantilla_whatsapp":
            salida.append({"nombre": nombre, "descripcion": desc or (
                "Envía al contacto por WhatsApp la plantilla configurada (p. ej. con un enlace o información)."),
                "parametros": _esquema(h.get("parametros", []))})
        elif t == "transferir_llamada":
            salida.append({"nombre": nombre, "descripcion": desc or (
                "Transfiere la llamada a una persona del equipo cuando el contacto lo pide o el caso lo requiere."),
                "parametros": {"type": "object", "properties": {"motivo": {"type": "string"}}}})
        elif t == "colgar":
            salida.append({"nombre": nombre, "descripcion": desc or (
                "Termina la llamada. Úsala después de despedirte, o si es un buzón de voz o el contacto pide colgar."),
                "parametros": {"type": "object", "properties": {}}})
        elif t == "escalar_humano":
            salida.append({"nombre": nombre, "descripcion": desc or (
                "Pasa la conversación a una persona del equipo. Úsala si el contacto pide hablar con un humano, "
                "está molesto, o la consulta está fuera de tu alcance."),
                "parametros": {"type": "object", "properties": {"motivo": {"type": "string"}},
                               "required": ["motivo"]}})
        elif t == "guardar_dato":
            params = h.get("parametros") or [
                {"nombre": "campo", "tipo": "texto", "descripcion": "Nombre del dato (p. ej. presupuesto)"},
                {"nombre": "valor", "tipo": "texto", "descripcion": "Valor"}]
            salida.append({"nombre": nombre, "descripcion": desc or "Guarda un dato del contacto en el CRM.",
                           "parametros": _esquema(params)})
        elif t == "api":
            salida.append({"nombre": re.sub(r"[^a-zA-Z0-9_-]", "_", nombre)[:60],
                           "descripcion": desc or "Consulta un sistema externo.",
                           "parametros": _esquema(h.get("parametros", []))})
    return salida


def _herramienta_cfg(config: dict, nombre_llm: str) -> dict | None:
    for h in config.get("herramientas", []):
        if not h.get("activa", True):
            continue
        n = h.get("nombre") or h["tipo"]
        if h["tipo"] == "api":
            n = re.sub(r"[^a-zA-Z0-9_-]", "_", n)[:60]
        if n == nombre_llm or (h["tipo"] == "agendar_cita" and nombre_llm in ("consultar_disponibilidad",
                                                                              "agendar_cita")):
            return h
    return None


def _rellenar(plantilla: str, valores: dict) -> str:
    return re.sub(r"\{\{\s*([\w.]+)\s*\}\}", lambda m: str(valores.get(m.group(1), m.group(0))), plantilla or "")


async def ejecutar(ctx: ContextoTurno, nombre: str, args: dict) -> str:
    """Ejecuta una herramienta y devuelve el resultado como texto para el LLM."""
    h = _herramienta_cfg(ctx.config, nombre)
    if not h:
        return f"Error: la herramienta {nombre} no existe."
    t = h["tipo"]
    c = h.get("config", {})
    try:
        if t == "buscar_conocimiento":
            k = ctx.config.get("conocimiento", {})
            res = await conocimiento.buscar(ctx.db, ctx.espacio_id, k.get("cerebro_ids", []),
                                            args.get("consulta", ""), k.get("top_k", 4), k.get("umbral", 0.35))
            if not res:
                return "Sin resultados en la base de conocimiento. Si no sabes la respuesta, dilo y ofrece ayuda."
            ctx.fuentes += [{"titulo": r["titulo"], "url": r["url"]} for r in res]
            return "\n\n---\n\n".join(f"[{r['titulo']}]({r['url']})\n{r['texto']}" if r["url"] else
                                      f"[{r['titulo']}]\n{r['texto']}" for r in res)

        if t == "agendar_cita":
            zona = c.get("zona_horaria") or ctx.zona
            if nombre == "consultar_disponibilidad":
                desde = date.fromisoformat(args["desde"]) if args.get("desde") else agenda.hoy_en(zona)
                huecos = await agenda.disponibilidad(ctx.db, ctx.espacio_id, c, zona, desde)
                if not huecos:
                    return "No hay horarios libres en los próximos días."
                return "Horarios libres (hora local " + zona + "):\n" + "\n".join(
                    f"{d}: {', '.join(hs[:12])}" for d, hs in huecos.items())
            if ctx.simulado:
                return f"(simulado) Cita agendada para {args.get('inicio')}."
            inicio = datetime.fromisoformat(args["inicio"])
            cita = await agenda.agendar(ctx.db, ctx.espacio_id, c, zona, inicio, ctx.contacto,
                                        ctx.agente.id if ctx.agente else None,
                                        ctx.conversacion.id if ctx.conversacion else None,
                                        args.get("notas", ""), args.get("email", ""))
            if ctx.contacto and args.get("email") and not ctx.contacto.email:
                ctx.contacto.email = args["email"]
            emitir(ctx.db, ctx.espacio_id, "cita.agendada", {
                "cita_id": cita.id, "inicio_utc": cita.inicio.isoformat(), "contacto_id": cita.contacto_id,
                "conversacion_id": cita.conversacion_id, "proveedor": cita.proveedor})
            ctx.accion("cita_agendada", cita_id=cita.id)
            return f"Cita confirmada para {inicio.strftime('%Y-%m-%d %H:%M')} ({zona})."

        if t == "enviar_plantilla_whatsapp":
            if ctx.simulado:
                return "(simulado) Plantilla enviada por WhatsApp."
            from ..canales import whatsapp

            plantilla = ctx.db.get(Plantilla, int(c.get("plantilla_id") or 0))
            if plantilla and plantilla.espacio_id != ctx.espacio_id:
                plantilla = None  # nunca usar plantillas (ni líneas) de otro espacio
            if not plantilla or not ctx.contacto or not ctx.contacto.telefono:
                return "No se pudo enviar: falta la plantilla o el teléfono del contacto."
            if ctx.contacto.opt_out_whatsapp:
                return "No se envió: el contacto pidió no recibir WhatsApp."
            linea = ctx.db.get(LineaWhatsapp, plantilla.linea_id)
            if not linea or linea.espacio_id != ctx.espacio_id:
                return "No se pudo enviar: la línea de WhatsApp de la plantilla no está disponible."
            valores = {**ctx.variables, **args}
            variables = [_rellenar(v, valores) for v in c.get("variables", [])]
            wamid = await whatsapp.enviar_plantilla(linea, ctx.contacto.telefono, plantilla.nombre,
                                                    plantilla.idioma, variables)
            from .motor import registrar_saliente_whatsapp

            registrar_saliente_whatsapp(ctx.db, ctx.espacio_id, linea, ctx.contacto, plantilla, variables, wamid,
                                        ctx.agente.id if ctx.agente else None)
            return "Plantilla enviada por WhatsApp correctamente."

        if t == "transferir_llamada":
            numero = c.get("numero") or ctx.config.get("voz", {}).get("numero_transferencia")
            if not numero:
                return "No hay número de transferencia configurado; ofrece que alguien devuelva la llamada."
            ctx.accion("transferir", numero=numero, motivo=args.get("motivo", ""))
            return "Transfiriendo la llamada."

        if t == "colgar":
            ctx.accion("colgar")
            return "Llamada finalizada."

        if t == "escalar_humano":
            ctx.accion("escalar", motivo=args.get("motivo", ""))
            if ctx.canal == "voz":
                numero = ctx.config.get("voz", {}).get("numero_transferencia")
                if numero:
                    ctx.accion("transferir", numero=numero, motivo=args.get("motivo", ""))
                    return "Transfiriendo con una persona del equipo."
                return "Nadie del equipo puede atender ahora; ofrece que te devuelvan la llamada."
            return "Listo: una persona del equipo continuará la conversación. Avísale al contacto."

        if t == "guardar_dato":
            if ctx.contacto is not None and not ctx.simulado:
                datos = dict(ctx.contacto.datos_ia or {})
                if set(args) == {"campo", "valor"}:
                    datos[str(args["campo"])] = args["valor"]
                else:
                    datos.update(args)
                ctx.contacto.datos_ia = datos
                if "email" in args and not ctx.contacto.email:
                    ctx.contacto.email = str(args["email"])
                ctx.db.commit()
            return "Dato guardado."

        if t == "api":
            if ctx.simulado and c.get("efectos", True) and c.get("metodo", "GET").upper() != "GET":
                return "(simulado) Acción ejecutada."
            valores = {**(ctx.contacto.atributos if ctx.contacto else {}), **ctx.variables, **args}
            url = validar_url_externa(_rellenar(c.get("url", ""), valores))
            encabezados = {k: _rellenar(v, valores) for k, v in (c.get("encabezados") or {}).items()}
            metodo = c.get("metodo", "POST").upper()
            cuerpo = None
            if metodo != "GET":
                plantilla = c.get("cuerpo_plantilla")
                cuerpo = json.loads(_rellenar(plantilla, {k: json.dumps(v)[1:-1] if isinstance(v, str) else v
                                                          for k, v in valores.items()})) if plantilla else args
            async with httpx.AsyncClient(timeout=float(c.get("timeout_s", 10))) as cliente:
                r = await cliente.request(metodo, url, headers=encabezados,
                                          params=args if metodo == "GET" else None, json=cuerpo)
            return f"HTTP {r.status_code}: {r.text[:2000]}"
    except (agenda.ErrorAgenda, UrlNoPermitida, httpx.HTTPError, ValueError, KeyError) as e:
        return f"Error al ejecutar {nombre}: {e}"
    except Exception as e:  # una herramienta rota nunca debe tumbar la conversación
        return f"Error inesperado en {nombre}: {type(e).__name__}: {e}"
    return "Herramienta sin efecto."


def mensaje_espera(config: dict, nombre: str) -> str:
    h = _herramienta_cfg(config, nombre)
    return (h or {}).get("mensaje_espera", "")

