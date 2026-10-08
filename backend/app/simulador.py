"""Simulador: un LLM hace de contacto (persona + comportamiento) y conversa con el agente
antes de gastar llamadas o mensajes reales; un juez califica con rúbrica."""
import asyncio
import logging

from sqlalchemy.orm import Session

from . import llm
from .cerebro.herramientas import ContextoTurno
from .cerebro.motor import config_de, turno, variables_de
from .modelos import Agente, Espacio, Simulacion

RUBRICA_DEFECTO = [
    "Cumple sus instrucciones y avanza hacia su objetivo",
    "No inventa información (precios, fechas, políticas)",
    "Tono y brevedad adecuados al canal",
    "Maneja objeciones con empatía y sin presionar",
    "Usa las herramientas cuando corresponde (conocimiento, agenda, escalar)",
]
COMPORTAMIENTOS = ["cooperativo", "apurado", "escéptico", "confundido", "pide hablar con un humano",
                   "hace preguntas fuera de tema", "pregunta precios de una", "molesto por la llamada"]
FIN = "[FIN]"
log = logging.getLogger("platzito.simulador")
PERSONAS_DEFECTO = {
    "cooperativo": ("Laura, 32 años, interesada y con tiempo para conversar", "Entender la oferta y avanzar"),
    "apurado": ("Andrés, gerente con poco tiempo, contesta entre reuniones", "Obtener lo esencial en un minuto"),
    "escéptico": ("Mariana, ya tuvo malas experiencias con servicios parecidos", "Comprobar que no la engañan"),
    "confundido": ("Don Jorge, 61 años, no entiende bien de qué se trata", "Entender quién lo contacta y para qué"),
    "pide hablar con un humano": ("Camilo, prefiere no hablar con bots", "Que lo atienda una persona"),
    "hace preguntas fuera de tema": ("Sofía, curiosa y dispersa", "Resolver dudas que no tienen que ver"),
    "pregunta precios de una": ("Felipe, compara opciones y va directo al grano", "Saber el precio exacto ya"),
    "molesto por la llamada": ("Patricia, no pidió que la contactaran", "Que no la vuelvan a contactar"),
}


async def generar_escenarios(db: Session, agente: Agente, n: int = 5) -> list[dict]:
    cfg = config_de(agente, borrador=True)
    prov = llm.proveedor(db, agente.espacio_id, cfg["modelo"]["proveedor"] or None, cfg["modelo"]["nombre"] or None)
    esquema = {"type": "object", "properties": {"escenarios": {"type": "array", "items": {
        "type": "object", "properties": {
            "nombre": {"type": "string"}, "persona": {"type": "string", "description": "Quién es, contexto, datos"},
            "comportamiento": {"type": "string", "enum": COMPORTAMIENTOS},
            "objetivo": {"type": "string", "description": "Qué quiere lograr el contacto"},
            "canal": {"type": "string", "enum": ["whatsapp", "voz"]}},
        "required": ["nombre", "persona", "comportamiento", "objetivo", "canal"]}}}, "required": ["escenarios"]}
    datos, _ = await prov.json(
        "Diseñas casos de prueba realistas y variados para agentes conversacionales en Latinoamérica.",
        f"Instrucciones del agente:\n{cfg['instrucciones']}\n\nPropósito: {cfg.get('proposito', '')}\n\n"
        f"Genera {n} escenarios distintos, incluyendo al menos uno difícil y uno que pida un humano.", esquema)
    return [e for e in datos.get("escenarios", []) if isinstance(e, dict) and e.get("persona")][:n]


def escenarios_por_defecto(n: int = 5) -> list[dict]:
    """Respaldo cuando el modelo no genera escenarios (pasa con modelos locales pequeños)."""
    elegidos = ["cooperativo", "escéptico", "pide hablar con un humano", "pregunta precios de una", "apurado",
                "confundido", "hace preguntas fuera de tema", "molesto por la llamada"]
    return [{"nombre": f"Contacto {c}", "persona": PERSONAS_DEFECTO[c][0], "comportamiento": c,
             "objetivo": PERSONAS_DEFECTO[c][1], "canal": "whatsapp"} for c in elegidos[:n] if c in COMPORTAMIENTOS]


async def _conversar(db: Session, agente: Agente, cfg: dict, esc: dict, max_turnos: int) -> dict:
    canal = esc.get("canal", "whatsapp")
    espacio = db.get(Espacio, agente.espacio_id)
    ctx = ContextoTurno(db=db, espacio_id=agente.espacio_id, agente=agente, config=cfg, canal=canal,
                        variables=variables_de(cfg, None, {"nombre": esc.get("nombre_contacto", "")}),
                        zona=espacio.zona_horaria, simulado=True)
    persona = llm.proveedor(db, agente.espacio_id, cfg["modelo"]["proveedor"] or None,
                            cfg["modelo"]["nombre"] or None)
    sistema_persona = (
        f"Simulas ser un contacto real en una conversación por {'teléfono' if canal == 'voz' else 'WhatsApp'}. "
        f"Persona: {esc.get('persona')}. Comportamiento: {esc.get('comportamiento')}. "
        f"Tu objetivo: {esc.get('objetivo')}. Responde solo con lo que diría esa persona, en 1-3 frases, sin "
        f"narrar acciones. Si la conversación ya terminó (se despidieron, te transfirieron o colgaron), "
        f"responde exactamente {FIN}.")
    transcript: list[dict] = []  # {"rol": "agente"|"contacto", "texto", "herramientas"}
    hist_agente: list[dict] = []
    entrada = salida = 0
    costo = 0.0
    if cfg["quien_habla_primero"] == "agente" and cfg.get("mensaje_inicial"):
        from .cerebro.motor import rellenar

        saludo = rellenar(cfg["mensaje_inicial"], ctx.variables)
        transcript.append({"rol": "agente", "texto": saludo})
        hist_agente.append({"rol": "usuario", "texto": "(el contacto contesta)"})
        hist_agente.append({"rol": "asistente", "texto": saludo})
    fin = ""
    for _ in range(max_turnos):
        hist_persona = [{"rol": "usuario" if t["rol"] == "agente" else "asistente", "texto": t["texto"]}
                        for t in transcript if t["texto"]]
        if not hist_persona:
            hist_persona = [{"rol": "usuario", "texto": "(Empieza tú la conversación.)"}]
        rp = await persona.completar(sistema_persona, hist_persona, None, 0.8, 200)
        entrada += rp.entrada
        salida += rp.salida
        costo += llm.costo(persona.modelo, rp.entrada, rp.salida)
        dicho = rp.texto.strip()
        if not dicho or FIN in dicho:
            fin = "contacto_termino"
            break
        transcript.append({"rol": "contacto", "texto": dicho})
        hist_agente.append({"rol": "usuario", "texto": dicho})
        ctx.acciones = []
        r = await turno(ctx, hist_agente)
        entrada += r["entrada"]
        salida += r["salida"]
        costo += r["costo"]
        for ronda in r["rondas"]:
            hist_agente.append({"rol": "asistente", "texto": ronda["texto"], "llamadas": ronda["llamadas"]})
            hist_agente += [{"rol": "herramienta", "id": x["id"], "nombre": x["nombre"], "resultado": x["resultado"]}
                            for x in ronda["resultados"]]
        texto = " ".join(r["textos"])
        if r["texto"]:
            hist_agente.append({"rol": "asistente", "texto": r["texto"]})
        transcript.append({"rol": "agente", "texto": texto, "herramientas": [
            {"nombre": x["nombre"], "args": x["args"], "resultado": str(x["resultado"])[:300]}
            for ronda in r["rondas"] for x in ronda["resultados"]], "acciones": r["acciones"]})
        terminales = {a["tipo"] for a in r["acciones"]} & {"colgar", "transferir", "escalar"}
        if terminales:
            fin = ",".join(sorted(terminales))
            break
    return {"transcript": transcript, "fin": fin or "max_turnos", "entrada": entrada, "salida": salida,
            "costo": costo}


async def _juzgar(db: Session, agente: Agente, cfg: dict, esc: dict, transcript: list[dict], rubrica: list[str]
                  ) -> dict:
    prov = llm.proveedor(db, agente.espacio_id, cfg["modelo"]["proveedor"] or None, cfg["modelo"]["nombre"] or None)
    texto = "\n".join(f"{'Agente' if t['rol'] == 'agente' else 'Contacto'}: {t['texto']}"
                      + (f"  [herramientas: {', '.join(h['nombre'] for h in t.get('herramientas', []))}]"
                         if t.get("herramientas") else "") for t in transcript)
    esquema = {"type": "object", "properties": {
        "criterios": {"type": "array", "items": {"type": "object", "properties": {
            "criterio": {"type": "string"}, "puntaje": {"type": "integer", "minimum": 0, "maximum": 10},
            "comentario": {"type": "string"}}, "required": ["criterio", "puntaje", "comentario"]}},
        "objetivo_cumplido": {"type": "boolean"},
        "problemas": {"type": "array", "items": {"type": "string"}},
        "sugerencias_prompt": {"type": "array", "items": {"type": "string"},
                               "description": "Cambios concretos a las instrucciones del agente"}},
        "required": ["criterios", "objetivo_cumplido", "problemas", "sugerencias_prompt"]}
    datos, _ = await prov.json(
        "Eres un evaluador exigente de agentes conversacionales de ventas y servicio. Califica con evidencia del "
        "transcript.",
        f"Instrucciones del agente:\n{cfg['instrucciones']}\n\nEscenario: {esc}\n\nRúbrica:\n- "
        + "\n- ".join(rubrica) + f"\n\nTranscript:\n{texto}", esquema)
    criterios = datos.get("criterios", [])
    datos["puntaje"] = round(sum(c.get("puntaje", 0) for c in criterios) / len(criterios), 2) if criterios else 0
    return datos


async def correr(db: Session, simulacion_id: int):
    sim = db.get(Simulacion, simulacion_id)
    agente = db.get(Agente, sim.agente_id)
    cfg = config_de(agente, borrador=sim.usar_borrador)
    rubrica = sim.rubrica or RUBRICA_DEFECTO
    sim.estado, sim.error, sim.resultados = "corriendo", "", []
    db.commit()
    try:
        if not sim.escenarios:
            try:
                escenarios = await generar_escenarios(db, agente)
            except llm.ErrorLLM as e:
                log.warning("No se pudieron generar escenarios (%s); se usan los de por defecto", e)
                escenarios = []
            sim.escenarios = escenarios or escenarios_por_defecto()
            db.commit()
        if not sim.escenarios:
            raise llm.ErrorLLM("No hay escenarios para simular: el modelo no generó ninguno. Escribe al menos uno.")
        resultados = []
        for esc in sim.escenarios:
            conv = await _conversar(db, agente, cfg, esc, sim.max_turnos)
            evaluacion = await _juzgar(db, agente, cfg, esc, conv["transcript"], rubrica)
            resultados.append({"escenario": esc, **conv, "evaluacion": evaluacion})
            sim.resultados = list(resultados)
            db.commit()
            await asyncio.sleep(0)
        puntajes = [r["evaluacion"].get("puntaje", 0) for r in resultados]
        sim.puntaje = round(sum(puntajes) / len(puntajes), 2) if puntajes else None
        sim.estado = "lista"
    except llm.ErrorLLM as e:
        sim.estado, sim.error = "fallida", str(e)[:500]
    db.commit()
