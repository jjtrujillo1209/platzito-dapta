"""El cerebro del agente: un solo bucle agéntico para texto, WhatsApp, widget y voz.

Incluye las guardas deterministas que salieron de la validación empírica:
  1. Texto que parece una llamada a herramienta escrita a mano nunca se envía.
  2. Si el contacto pide un humano y el modelo no escaló, se escala igual.
  3. En voz, si ambos se despiden, se cuelga aunque el modelo no lo pida.
"""
import asyncio
import re
from datetime import datetime
from typing import AsyncIterator
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import llm
from ..db import ahora
from ..eventos import emitir
from ..modelos import Agente, Contacto, Conversacion, Envio, Espacio, LineaWhatsapp, Mensaje, Plantilla
from .config import normalizar
from .herramientas import ContextoTurno, definiciones, ejecutar, mensaje_espera

# ─────────────────────────────── Guardas ───────────────────────────────

PATRON_HERRAMIENTA_TEXTO = re.compile(
    r"(<\s*/?\s*(tool|function)[_\s]?(call|use)?|<\|.*?\|>|\{\s*\"(name|tool|function|tool_name|arguments)\"\s*:"
    r"|```(json|tool)|\bfunction_call\b|^\s*(buscar_conocimiento|escalar_humano|colgar|agendar_cita|"
    r"consultar_disponibilidad|guardar_dato|transferir_llamada)\s*\()",
    re.I | re.M)
PIDE_HUMANO = re.compile(
    r"(habl|comunic|pas|contact|comuni)\w*\s+(me\s+)?(con\s+)?(un[ao]?\s+|alguna?\s+)?"
    r"(humano|persona|asesor|asesora|agente\s+(real|humano)|alguien\s+(real|del equipo)|operador)"
    r"|\b(quiero|necesito|prefiero)\s+(un[ao]?\s+)?(humano|persona real|asesor)", re.I)
DESPEDIDA_CONTACTO = re.compile(
    r"\b(adi[oó]s|chao|chau|hasta (luego|pronto|mañana)|nos vemos|bye|eso (es|ser[ií]a) todo|"
    r"no,? (muchas )?gracias)\b", re.I)
DESPEDIDA_AGENTE = re.compile(
    r"\b(adi[oó]s|hasta (luego|pronto)|que (tengas|tenga|estés|esté) (un )?(buen|excelente|feliz|lindo)|"
    r"feliz (día|tarde|noche)|un gusto (hablar|conversar))\b", re.I)
FIN_FRASE = re.compile(r"[.!?…\n]\s|[.!?…]$")


class FiltroTexto:
    """Libera el texto por frases y descarta las que parecen herramientas escritas a mano."""

    def __init__(self):
        self.buffer = ""
        self.descartado = False

    def _limpiar(self, frase: str) -> str:
        if PATRON_HERRAMIENTA_TEXTO.search(frase):
            self.descartado = True
            return ""
        return frase

    def alimentar(self, delta: str) -> str:
        self.buffer += delta
        salida = ""
        while True:
            m = FIN_FRASE.search(self.buffer)
            if not m:
                if len(self.buffer) > 160 and " " in self.buffer[80:]:
                    corte = self.buffer.rfind(" ")
                    salida += self._limpiar(self.buffer[:corte + 1])
                    self.buffer = self.buffer[corte + 1:]
                break
            frase, self.buffer = self.buffer[:m.end()], self.buffer[m.end():]
            salida += self._limpiar(frase)
        return salida

    def vaciar(self) -> str:
        resto, self.buffer = self.buffer, ""
        return self._limpiar(resto)


# ─────────────────────────────── Prompt ───────────────────────────────

DIAS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
            "noviembre", "diciembre"]
CANAL_NOMBRE = {"whatsapp": "WhatsApp", "widget": "chat web", "voz": "llamada telefónica", "correo": "correo",
                "sms": "SMS", "playground": "chat de pruebas", "simulador": "chat de pruebas"}
ESTILO = {
    "voz": ("Estás en una llamada de voz. Habla natural y breve: una o dos frases por turno, una sola pregunta a la "
            "vez. Nada de markdown, listas, emojis ni URLs. Di números, horas y precios como se pronuncian. "
            "Si te interrumpen, adapta tu respuesta. Si escuchas un buzón de voz, cuelga."),
    "whatsapp": ("Escribes por WhatsApp: mensajes cortos y cálidos (máximo 3 párrafos breves), sin encabezados ni "
                 "tablas. Puedes usar *negrita* con moderación. Una pregunta a la vez."),
    "widget": "Escribes en el chat de la web: respuestas breves y claras; markdown básico permitido.",
}


def config_de(agente: Agente, borrador: bool = False) -> dict:
    return normalizar(agente.config_borrador if borrador or not agente.config_publicada else agente.config_publicada)


def variables_de(cfg: dict, contacto: Contacto | None, conv_vars: dict | None) -> dict:
    v = dict(cfg.get("variables") or {})
    if contacto:
        v.update({k: val for k, val in (contacto.atributos or {}).items() if val not in (None, "")})
        v.update({"nombre": contacto.nombre or v.get("nombre", ""), "telefono": contacto.telefono or "",
                  "email": contacto.email or "", "empresa": contacto.empresa or v.get("empresa", "")})
        v.setdefault("primer_nombre", (contacto.nombre or "").split(" ")[0])
    v.update(conv_vars or {})
    return v


def rellenar(texto: str, variables: dict) -> str:
    return re.sub(r"\{\{\s*([\w.]+)\s*\}\}", lambda m: str(variables.get(m.group(1), "")), texto or "")


def fecha_humana(zona: str) -> str:
    n = datetime.now(ZoneInfo(zona))
    return f"{DIAS_ES[n.weekday()]} {n.day} de {MESES_ES[n.month - 1]} de {n.year}, {n:%H:%M} ({zona})"


def sistema(ctx: ContextoTurno) -> str:
    cfg = ctx.config
    partes = [rellenar(cfg["instrucciones"], ctx.variables).strip()]
    espacio = ctx.db.get(Espacio, ctx.espacio_id)
    if cfg.get("usar_contexto_empresa") and espacio and espacio.contexto_empresa.strip():
        partes.append("## Contexto de la empresa\n" + espacio.contexto_empresa.strip())
    situacion = [f"- Fecha y hora: {fecha_humana(ctx.zona)}", f"- Canal: {CANAL_NOMBRE.get(ctx.canal, ctx.canal)}"]
    if ctx.contacto:
        c = ctx.contacto
        datos = [f"- Nombre: {c.nombre}" if c.nombre else "", f"- Empresa: {c.empresa}" if c.empresa else "",
                 f"- Teléfono: {c.telefono}" if c.telefono else "", f"- Correo: {c.email}" if c.email else ""]
        datos += [f"- {k}: {v}" for k, v in (c.datos_ia or {}).items() if v not in (None, "")]
        datos = [d for d in datos if d]
        if datos:
            situacion.append("- Lo que sabemos del contacto:\n  " + "\n  ".join(datos))
    partes.append("## Situación\n" + "\n".join(situacion))
    if ctx.canal in ESTILO:
        partes.append("## Estilo\n" + ESTILO[ctx.canal])
    nombres = {h["nombre"] for h in definiciones(cfg, ctx.canal)}
    reglas = ["Nunca escribas llamadas a herramientas como texto: usa la herramienta directamente.",
              "No inventes datos (precios, fechas, políticas, disponibilidad)."]
    if "buscar_conocimiento" in nombres:
        reglas.append("Antes de responder sobre la empresa, sus productos o políticas, usa buscar_conocimiento.")
    if "escalar_humano" in nombres:
        reglas.append("Si el contacto pide hablar con una persona o está molesto, usa escalar_humano.")
    if "colgar" in nombres:
        reglas.append("Cuando la conversación termine, despídete en una frase y usa colgar.")
    if cfg["conocimiento"].get("mostrar_fuentes") and ctx.canal != "voz":
        reglas.append("Cuando uses la base de conocimiento, cita el enlace de la fuente al final.")
    partes.append("## Reglas\n- " + "\n- ".join(reglas))
    return "\n\n".join(p for p in partes if p)


def historial(db: Session, conv: Conversacion, limite: int = 40) -> list[dict]:
    filas = db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id, Mensaje.tipo != "nota")
                       .order_by(Mensaje.id.desc()).limit(limite)).all()[::-1]
    mensajes: list[dict] = []
    for m in filas:
        if m.autor == "contacto":
            mensajes.append({"rol": "usuario", "texto": m.contenido})
        elif m.tipo == "herramienta":
            llamadas = m.datos.get("llamadas", [])
            mensajes.append({"rol": "asistente", "texto": m.contenido, "llamadas": llamadas})
            for r in m.datos.get("resultados", []):
                mensajes.append({"rol": "herramienta", "id": r["id"], "nombre": r["nombre"],
                                 "resultado": r["resultado"]})
        elif m.autor in ("ia", "humano") or m.tipo == "plantilla":
            prefijo = "[Mensaje de una persona del equipo] " if m.autor == "humano" else ""
            mensajes.append({"rol": "asistente", "texto": prefijo + m.contenido})
    # El historial debe empezar con un mensaje del usuario y no puede cortar un par llamada/resultado
    while mensajes and mensajes[0]["rol"] == "herramienta":
        mensajes.pop(0)
    return mensajes


# ─────────────────────────────── Bucle agéntico ───────────────────────────────

async def turno_stream(ctx: ContextoTurno, mensajes: list[dict]) -> AsyncIterator[tuple]:
    """Eventos: ("texto", delta) · ("espera", texto) · ("herramienta", ronda) · ("fin", resumen)."""
    cfg = ctx.config
    m = cfg["modelo"]
    prov = llm.proveedor(ctx.db, ctx.espacio_id, m.get("proveedor") or None, m.get("nombre") or None)
    herramientas = definiciones(cfg, ctx.canal)
    texto_sistema = sistema(ctx)
    trabajo = list(mensajes)
    entrada = salida = 0
    textos: list[str] = []
    rondas: list[dict] = []
    texto_final = ""
    max_rondas = int(cfg.get("guardas", {}).get("max_rondas_herramientas", 4))
    for n in range(max_rondas + 1):
        filtro = FiltroTexto()
        texto_ronda, llamadas = "", []
        usar_herramientas = herramientas if n < max_rondas else None
        async for ev in prov.stream(texto_sistema, trabajo, usar_herramientas, m["temperatura"], m["max_tokens"]):
            if ev[0] == "texto":
                limpio = filtro.alimentar(ev[1])
                if limpio:
                    texto_ronda += limpio
                    yield ("texto", limpio)
            elif ev[0] == "llamada":
                llamadas.append(ev[1])
            elif ev[0] == "fin":
                entrada += ev[1]["entrada"]
                salida += ev[1]["salida"]
        resto = filtro.vaciar()
        if resto:
            texto_ronda += resto
            yield ("texto", resto)
        if texto_ronda.strip():
            textos.append(texto_ronda.strip())
        if not llamadas:
            texto_final = texto_ronda.strip()
            break
        resultados = []
        for ll in llamadas:
            espera = mensaje_espera(cfg, ll["nombre"])
            if espera:
                yield ("espera", espera)
            res = await ejecutar(ctx, ll["nombre"], ll.get("args") or {})
            resultados.append({"id": ll["id"], "nombre": ll["nombre"], "args": ll.get("args") or {},
                               "resultado": res})
        ronda = {"texto": texto_ronda.strip(), "llamadas": llamadas, "resultados": resultados}
        rondas.append(ronda)
        yield ("herramienta", ronda)
        trabajo.append({"rol": "asistente", "texto": texto_ronda.strip(), "llamadas": llamadas})
        trabajo += [{"rol": "herramienta", "id": r["id"], "nombre": r["nombre"], "resultado": r["resultado"]}
                    for r in resultados]
        if any(a["tipo"] in ("colgar", "transferir") for a in ctx.acciones) and texto_ronda.strip():
            break  # ya se despidió y la acción terminal está en marcha
    _guardas(ctx, mensajes, " ".join(textos))
    yield ("fin", {"texto": texto_final, "textos": textos, "rondas": rondas, "acciones": ctx.acciones,
                   "entrada": entrada, "salida": salida, "modelo": prov.modelo,
                   "costo": llm.costo(prov.modelo, entrada, salida), "fuentes": ctx.fuentes})


def _guardas(ctx: ContextoTurno, mensajes: list[dict], respuesta: str):
    g = ctx.config.get("guardas", {})
    ultimo = next((m["texto"] for m in reversed(mensajes) if m["rol"] == "usuario"), "")
    tipos = {a["tipo"] for a in ctx.acciones}
    nombres = {h["nombre"] for h in definiciones(ctx.config, ctx.canal)}
    if g.get("escalar_si_pide_humano", True) and "escalar" not in tipos and "escalar_humano" in nombres \
            and PIDE_HUMANO.search(ultimo):
        ctx.accion("escalar", motivo="El contacto pidió hablar con una persona (guarda)")
        if ctx.canal == "voz" and ctx.config.get("voz", {}).get("numero_transferencia") and "transferir" not in tipos:
            ctx.accion("transferir", numero=ctx.config["voz"]["numero_transferencia"], motivo="pidió humano")
    if ctx.canal == "voz" and g.get("colgar_en_despedida", True) and "colgar" not in tipos \
            and DESPEDIDA_CONTACTO.search(ultimo) and DESPEDIDA_AGENTE.search(respuesta):
        ctx.accion("colgar", motivo="despedida (guarda)")


async def turno(ctx: ContextoTurno, mensajes: list[dict]) -> dict:
    resumen = {}
    async for ev in turno_stream(ctx, mensajes):
        if ev[0] == "fin":
            resumen = ev[1]
    return resumen


# ─────────────────────────────── Conversaciones de texto ───────────────────────────────

_candados: dict[int, asyncio.Lock] = {}
_versiones: dict[int, int] = {}


def contexto_para(db: Session, conv: Conversacion, agente: Agente, borrador: bool = False) -> ContextoTurno:
    cfg = config_de(agente, borrador)
    contacto = db.get(Contacto, conv.contacto_id) if conv.contacto_id else None
    espacio = db.get(Espacio, conv.espacio_id)
    zona = (contacto.zona_horaria if contacto and contacto.zona_horaria else None) or espacio.zona_horaria
    canal = conv.canal
    if canal in ("playground", "simulador"):
        canal = (conv.variables or {}).get("_estilo", "widget")  # el playground imita el estilo de un canal
    return ContextoTurno(db=db, espacio_id=conv.espacio_id, agente=agente, config=cfg, canal=canal,
                         conversacion=conv, contacto=contacto, variables=variables_de(cfg, contacto, conv.variables),
                         zona=zona, simulado=conv.canal in ("playground", "simulador"))


def partir(texto: str, max_partes: int = 3) -> list[str]:
    partes = [p.strip() for p in re.split(r"\n\s*\n", texto) if p.strip()]
    if len(partes) <= max_partes:
        return partes or [texto]
    return partes[:max_partes - 1] + ["\n\n".join(partes[max_partes - 1:])]


async def _entregar(db: Session, conv: Conversacion, msj: Mensaje):
    if conv.canal != "whatsapp" or not conv.linea_id:
        msj.estado_entrega = "entregado"
        return
    from ..canales import whatsapp

    linea = db.get(LineaWhatsapp, conv.linea_id)
    contacto = db.get(Contacto, conv.contacto_id)
    try:
        msj.wamid = await whatsapp.enviar_texto(linea, contacto.telefono, msj.contenido)
        msj.estado_entrega = "enviado"
    except whatsapp.ErrorWhatsapp as e:
        msj.estado_entrega, msj.error = "fallido", str(e)[:500]


def aplicar_acciones_texto(db: Session, conv: Conversacion, acciones: list[dict]):
    for a in acciones:
        if a["tipo"] == "escalar" and conv.ia_activa:
            conv.ia_activa = False
            conv.estado = "esperando_humano"
            conv.motivo_escalado = (a.get("motivo") or "")[:300]
            db.add(Mensaje(conversacion_id=conv.id, direccion="interno", autor="sistema", tipo="nota",
                           contenido=f"Escalado a humano: {conv.motivo_escalado}"))
            emitir(db, conv.espacio_id, "conversacion.escalada", {"conversacion_id": conv.id,
                                                                    "motivo": conv.motivo_escalado})
        elif a["tipo"] == "cita_agendada":
            from ..secuencias import al_agendar

            if conv.contacto_id:
                al_agendar(db, conv.contacto_id)


async def responder(db: Session, conversacion_id: int, borrador: bool = False) -> list[Mensaje]:
    """Genera y entrega la respuesta del agente a una conversación de texto."""
    candado = _candados.setdefault(conversacion_id, asyncio.Lock())
    async with candado:
        db.expire_all()
        conv = db.get(Conversacion, conversacion_id)
        if not conv or not conv.ia_activa or not conv.agente_id:
            return []
        agente = db.get(Agente, conv.agente_id)
        if not agente:
            return []
        ctx = contexto_para(db, conv, agente, borrador or conv.canal in ("playground", "simulador"))
        mensajes = historial(db, conv)
        if not mensajes or mensajes[-1]["rol"] != "usuario":
            return []
        try:
            r = await turno(ctx, mensajes)
        except llm.ErrorLLM as e:
            db.add(Mensaje(conversacion_id=conv.id, direccion="interno", autor="sistema", tipo="nota",
                           contenido=f"Error del modelo: {e}"))
            db.commit()
            raise
        nuevos: list[Mensaje] = []
        for ronda in r["rondas"]:
            m = Mensaje(conversacion_id=conv.id, direccion="saliente", autor="ia", tipo="herramienta",
                        contenido=ronda["texto"], datos={"llamadas": ronda["llamadas"],
                                                         "resultados": ronda["resultados"]})
            db.add(m)
            nuevos.append(m)
        if r["texto"]:
            cfg_conv = ctx.config["conversacion"]
            partes = partir(r["texto"]) if cfg_conv.get("partir_respuestas") and conv.canal == "whatsapp" \
                else [r["texto"]]
            for p in partes:
                m = Mensaje(conversacion_id=conv.id, direccion="saliente", autor="ia", tipo="texto", contenido=p,
                            datos={"fuentes": r["fuentes"]} if r["fuentes"] else {})
                db.add(m)
                nuevos.append(m)
        db.flush()
        for m in nuevos:
            if m.contenido and m.direccion == "saliente":
                await _entregar(db, conv, m)
        conv.tokens_entrada += r["entrada"]
        conv.tokens_salida += r["salida"]
        conv.costo_usd = round(conv.costo_usd + r["costo"], 6)
        conv.ultimo_mensaje_en = conv.ultimo_ia_en = ahora()
        conv.seguimientos_enviados = 0
        aplicar_acciones_texto(db, conv, r["acciones"])
        db.commit()
        return nuevos


async def responder_con_demora(conversacion_id: int, demora_s: float):
    """Agrupa ráfagas de mensajes: solo responde la última tarea programada."""
    from ..db import FabricaSesion

    version = _versiones.get(conversacion_id, 0) + 1
    _versiones[conversacion_id] = version
    if demora_s > 0:
        await asyncio.sleep(demora_s)
    if _versiones.get(conversacion_id) != version:
        return
    db = FabricaSesion()
    try:
        await responder(db, conversacion_id)
    except llm.ErrorLLM:
        pass  # ya quedó la nota de error en la conversación
    finally:
        db.close()


# ─────────────────────────────── Utilidades de canal ───────────────────────────────

def conversacion_abierta(db: Session, espacio_id: int, contacto_id: int, canal: str, linea_id: int | None = None,
                         agente_id: int | None = None) -> Conversacion:
    consulta = select(Conversacion).where(Conversacion.espacio_id == espacio_id,
                                          Conversacion.contacto_id == contacto_id, Conversacion.canal == canal,
                                          Conversacion.estado != "cerrada")
    if linea_id:
        consulta = consulta.where(Conversacion.linea_id == linea_id)
    conv = db.scalars(consulta.order_by(Conversacion.id.desc())).first()
    if not conv:
        conv = Conversacion(espacio_id=espacio_id, contacto_id=contacto_id, canal=canal, linea_id=linea_id,
                            agente_id=agente_id, ia_activa=agente_id is not None)
        db.add(conv)
        db.flush()
    return conv


def es_baja(texto: str, palabras: list[str]) -> bool:
    t = (texto or "").strip().lower()
    return any(t == p or (len(p) > 5 and p in t) for p in palabras)


def registrar_saliente_whatsapp(db: Session, espacio_id: int, linea: LineaWhatsapp, contacto: Contacto,
                                plantilla: Plantilla | None, variables: list[str], wamid: str,
                                agente_id: int | None, secuencia_id: int | None = None,
                                texto: str | None = None) -> Mensaje:
    conv = conversacion_abierta(db, espacio_id, contacto.id, "whatsapp", linea.id, agente_id or linea.agente_id)
    if plantilla:
        contenido = plantilla.cuerpo
        for i, v in enumerate(variables, 1):
            contenido = contenido.replace(f"{{{{{i}}}}}", str(v))
    else:
        contenido = texto or ""
    m = Mensaje(conversacion_id=conv.id, direccion="saliente", autor="ia" if agente_id else "sistema",
                tipo="plantilla" if plantilla else "texto", contenido=contenido, wamid=wamid,
                estado_entrega="enviado", datos={"plantilla": plantilla.nombre if plantilla else None,
                                                  "variables": variables})
    db.add(m)
    db.add(Envio(espacio_id=espacio_id, contacto_id=contacto.id, canal="whatsapp", linea_id=linea.id,
                 categoria=plantilla.categoria if plantilla else "SERVICE", secuencia_id=secuencia_id))
    conv.ultimo_mensaje_en = ahora()
    contacto.ultimo_contacto_en = ahora()
    db.commit()
    return m
