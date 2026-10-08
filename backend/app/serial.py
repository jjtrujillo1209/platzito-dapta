"""Serialización de modelos a JSON para la API (sin exponer secretos)."""
from datetime import datetime

from .cerebro.config import normalizar
from .modelos import (Agente, Cerebro, Cita, Contacto, Conversacion, Fuente, Inscripcion, LineaWhatsapp, Llamada,
                      Mensaje, NumeroTelefono, Plantilla, Secuencia, Simulacion, TroncalSip)


def _f(v: datetime | None) -> str | None:
    return v.isoformat() + "Z" if v else None


def agente(a: Agente, completo: bool = False) -> dict:
    d = {"id": a.id, "nombre": a.nombre, "descripcion": a.descripcion, "version_publicada": a.version_publicada,
         "publicado": a.config_publicada is not None, "clave_publica": a.clave_publica,
         "retell_agent_id": a.retell_agent_id, "retell_sincronizado": _f(a.retell_sincronizado),
         "cambios_sin_publicar": a.config_publicada is not None and normalizar(a.config_borrador) != normalizar(
             a.config_publicada), "creado": _f(a.creado), "actualizado": _f(a.actualizado)}
    if completo:
        d["config"] = normalizar(a.config_borrador)
        d["config_publicada"] = normalizar(a.config_publicada) if a.config_publicada else None
    return d


def contacto(c: Contacto) -> dict:
    return {"id": c.id, "nombre": c.nombre, "telefono": c.telefono, "email": c.email, "empresa": c.empresa,
            "zona_horaria": c.zona_horaria, "etapa": c.etapa, "atributos": c.atributos, "datos_ia": c.datos_ia,
            "etiquetas": c.etiquetas, "opt_out_whatsapp": c.opt_out_whatsapp, "opt_out_llamadas": c.opt_out_llamadas,
            "opt_out_correo": c.opt_out_correo, "ultimo_contacto_en": _f(c.ultimo_contacto_en), "creado": _f(c.creado)}


def mensaje(m: Mensaje) -> dict:
    return {"id": m.id, "conversacion_id": m.conversacion_id, "direccion": m.direccion, "autor": m.autor,
            "tipo": m.tipo, "contenido": m.contenido, "datos": m.datos, "estado_entrega": m.estado_entrega,
            "error": m.error, "calificacion": m.calificacion, "autor_usuario_id": m.autor_usuario_id,
            "creado": _f(m.creado)}


def conversacion(c: Conversacion, ultimo: Mensaje | None = None) -> dict:
    d = {"id": c.id, "canal": c.canal, "estado": c.estado, "ia_activa": c.ia_activa, "asignado_a": c.asignado_a,
         "asignado_nombre": c.asignado.nombre if c.asignado else None,
         "agente_id": c.agente_id, "linea_id": c.linea_id, "motivo_escalado": c.motivo_escalado,
         "contacto": contacto(c.contacto) if c.contacto else None, "no_leidos": c.no_leidos,
         "ultimo_mensaje_en": _f(c.ultimo_mensaje_en), "ultimo_entrante_en": _f(c.ultimo_entrante_en),
         "resumen": c.resumen, "analisis": c.analisis, "exito": c.exito, "sentimiento": c.sentimiento,
         "calificacion": c.calificacion, "costo_usd": c.costo_usd, "tokens": c.tokens_entrada + c.tokens_salida,
         "inscripcion_id": c.inscripcion_id, "creado": _f(c.creado), "cerrado_en": _f(c.cerrado_en)}
    if ultimo is not None:
        d["ultimo_mensaje"] = {"contenido": ultimo.contenido[:160], "autor": ultimo.autor, "tipo": ultimo.tipo}
    return d


def llamada(l: Llamada) -> dict:
    return {"id": l.id, "conversacion_id": l.conversacion_id, "contacto_id": l.contacto_id, "agente_id": l.agente_id,
            "inscripcion_id": l.inscripcion_id, "retell_call_id": l.retell_call_id, "tipo": l.tipo,
            "direccion": l.direccion, "desde": l.desde, "hacia": l.hacia, "estado": l.estado,
            "resultado": l.resultado, "razon_desconexion": l.razon_desconexion, "intento": l.intento,
            "duracion_s": l.duracion_s, "grabacion_url": l.grabacion_url, "latencia_ms": l.latencia_ms,
            "costo_usd": l.costo_usd, "creado": _f(l.creado), "inicio": _f(l.inicio), "fin": _f(l.fin)}


def cerebro(c: Cerebro, fuentes: list[Fuente] | None = None) -> dict:
    d = {"id": c.id, "nombre": c.nombre, "descripcion": c.descripcion, "creado": _f(c.creado)}
    if fuentes is not None:
        d["fuentes"] = [fuente(f) for f in fuentes]
    return d


def fuente(f: Fuente) -> dict:
    return {"id": f.id, "cerebro_id": f.cerebro_id, "tipo": f.tipo, "nombre": f.nombre, "url": f.url,
            "estado": f.estado, "error": f.error, "n_fragmentos": f.n_fragmentos, "opciones": f.opciones,
            "actualizado": _f(f.actualizado), "creado": _f(f.creado)}


def linea(l: LineaWhatsapp, tope: int | None = None, enviados: int | None = None) -> dict:
    return {"id": l.id, "phone_number_id": l.phone_number_id, "waba_id": l.waba_id,
            "numero_visible": l.numero_visible, "nombre_verificado": l.nombre_verificado, "agente_id": l.agente_id,
            "calidad": l.calidad, "tier": l.tier, "estado": l.estado, "coexistencia": l.coexistencia,
            "tope_diario_manual": l.tope_diario_manual, "marketing_pausado": l.marketing_pausado,
            "calentamiento_desde": _f(l.calentamiento_desde), "calidad_revisada_en": _f(l.calidad_revisada_en),
            "tope_24h": tope, "enviados_24h": enviados, "creado": _f(l.creado)}


def plantilla(p: Plantilla) -> dict:
    return {"id": p.id, "linea_id": p.linea_id, "nombre": p.nombre, "idioma": p.idioma, "categoria": p.categoria,
            "estado": p.estado, "cuerpo": p.cuerpo, "n_variables": p.n_variables, "carpeta": p.carpeta,
            "componentes": p.componentes, "motivo_rechazo": p.motivo_rechazo, "creado": _f(p.creado)}


def troncal(t: TroncalSip) -> dict:
    return {"id": t.id, "nombre": t.nombre, "termination_uri": t.termination_uri, "usuario": t.usuario,
            "tiene_clave": bool(t.clave_cifrada), "canales": t.canales, "creado": _f(t.creado)}


def numero(n: NumeroTelefono, usados_24h: int | None = None) -> dict:
    return {"id": n.id, "numero": n.numero, "etiqueta": n.etiqueta, "proveedor": n.proveedor,
            "troncal_id": n.troncal_id, "agente_entrante_id": n.agente_entrante_id,
            "importado_retell": n.importado_retell, "tope_diario": n.tope_diario, "activo": n.activo,
            "usados_24h": usados_24h, "creado": _f(n.creado)}


def secuencia(s: Secuencia, conteos: dict | None = None) -> dict:
    return {"id": s.id, "nombre": s.nombre, "estado": s.estado, "pasos": s.pasos, "zona_horaria": s.zona_horaria,
            "usar_zona_contacto": s.usar_zona_contacto, "horario": s.horario, "ab_agentes": s.ab_agentes,
            "numeros_ids": s.numeros_ids, "linea_id": s.linea_id, "tamano_lote": s.tamano_lote,
            "segundos_entre_llamadas": s.segundos_entre_llamadas, "detener_al_responder": s.detener_al_responder,
            "detener_al_agendar": s.detener_al_agendar, "fecha_fin": _f(s.fecha_fin), "conteos": conteos or {},
            "creado": _f(s.creado)}


def inscripcion(i: Inscripcion) -> dict:
    return {"id": i.id, "secuencia_id": i.secuencia_id, "contacto": contacto(i.contacto) if i.contacto else None,
            "estado": i.estado, "paso": i.paso, "proximo_en": _f(i.proximo_en), "intentos_paso": i.intentos_paso,
            "agente_id": i.agente_id, "conecto": i.conecto, "respondio": i.respondio, "historial": i.historial,
            "ultimo_error": i.ultimo_error, "creado": _f(i.creado)}


def simulacion(s: Simulacion, completo: bool = False) -> dict:
    d = {"id": s.id, "agente_id": s.agente_id, "nombre": s.nombre, "estado": s.estado, "puntaje": s.puntaje,
         "error": s.error, "max_turnos": s.max_turnos, "usar_borrador": s.usar_borrador,
         "n_escenarios": len(s.escenarios or []), "n_resultados": len(s.resultados or []), "creado": _f(s.creado)}
    if completo:
        d |= {"escenarios": s.escenarios, "rubrica": s.rubrica, "resultados": s.resultados}
    return d


def cita(c: Cita) -> dict:
    return {"id": c.id, "contacto_id": c.contacto_id, "agente_id": c.agente_id, "conversacion_id": c.conversacion_id,
            "inicio": _f(c.inicio), "duracion_min": c.duracion_min, "estado": c.estado, "proveedor": c.proveedor,
            "notas": c.notas, "creado": _f(c.creado)}
