"""Modelo de datos de Platzito.

Todo cuelga de un `Espacio` (workspace / tenant). Las conversaciones unifican
todos los canales: una llamada de voz también es una `Conversacion` (canal
"voz") cuyo transcript son sus `Mensaje`; la `Llamada` guarda lo propio de la
telefonía (intento, resultado, duración, grabación).
"""
from datetime import datetime

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text,
                        UniqueConstraint, Index)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, ahora


def _id():
    return mapped_column(Integer, primary_key=True, autoincrement=True)


def _fk(tabla: str, nulo: bool = False, borrar: str = "CASCADE"):
    return mapped_column(ForeignKey(f"{tabla}.id", ondelete=borrar), nullable=nulo, index=True)


def _creado():
    return mapped_column(DateTime, default=ahora, nullable=False)


# ─────────────────────────── Espacios, usuarios y acceso ───────────────────────────

class Espacio(Base):
    __tablename__ = "espacios"
    id: Mapped[int] = _id()
    nombre: Mapped[str] = mapped_column(String(120))
    zona_horaria: Mapped[str] = mapped_column(String(64), default="America/Bogota")
    plan: Mapped[str] = mapped_column(String(20), default="pro")  # free | pro | scale | enterprise
    concurrencia_llamadas: Mapped[int] = mapped_column(Integer, default=5)
    contexto_empresa: Mapped[str] = mapped_column(Text, default="")
    creado: Mapped[datetime] = _creado()


class Usuario(Base):
    __tablename__ = "usuarios"
    id: Mapped[int] = _id()
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    nombre: Mapped[str] = mapped_column(String(120))
    clave_hash: Mapped[str] = mapped_column(String(200))
    activo: Mapped[bool] = mapped_column(Boolean, default=True)
    creado: Mapped[datetime] = _creado()


ROLES = ("propietario", "admin", "editor", "operador", "lector")


class Miembro(Base):
    __tablename__ = "miembros"
    __table_args__ = (UniqueConstraint("espacio_id", "usuario_id"),)
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    usuario_id: Mapped[int] = _fk("usuarios")
    rol: Mapped[str] = mapped_column(String(20), default="editor")
    creado: Mapped[datetime] = _creado()
    usuario: Mapped[Usuario] = relationship(lazy="joined")


class Invitacion(Base):
    __tablename__ = "invitaciones"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    email: Mapped[str] = mapped_column(String(200))
    rol: Mapped[str] = mapped_column(String(20))
    token: Mapped[str] = mapped_column(String(64), unique=True)
    usada: Mapped[bool] = mapped_column(Boolean, default=False)
    creado: Mapped[datetime] = _creado()


class ClaveApi(Base):
    __tablename__ = "claves_api"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    nombre: Mapped[str] = mapped_column(String(120))
    prefijo: Mapped[str] = mapped_column(String(16), index=True)
    hash: Mapped[str] = mapped_column(String(128))
    rol: Mapped[str] = mapped_column(String(20), default="editor")
    ultimo_uso: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    creado: Mapped[datetime] = _creado()


class Integracion(Base):
    """Credenciales de un proveedor para un espacio (cifradas)."""
    __tablename__ = "integraciones"
    __table_args__ = (UniqueConstraint("espacio_id", "tipo"),)
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    tipo: Mapped[str] = mapped_column(String(40))  # anthropic | openai | groq | gemini | retell | meta | smtp | calcom | hubspot
    config_cifrada: Mapped[str] = mapped_column(Text, default="")
    activa: Mapped[bool] = mapped_column(Boolean, default=True)
    creado: Mapped[datetime] = _creado()


# ─────────────────────────────────── Agentes ───────────────────────────────────

class Agente(Base):
    """Un agente omnicanal: el mismo cerebro atiende texto, WhatsApp, widget y voz."""
    __tablename__ = "agentes"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    nombre: Mapped[str] = mapped_column(String(120))
    descripcion: Mapped[str] = mapped_column(Text, default="")
    config_borrador: Mapped[dict] = mapped_column(JSON, default=dict)
    config_publicada: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    version_publicada: Mapped[int] = mapped_column(Integer, default=0)
    clave_publica: Mapped[str] = mapped_column(String(40), unique=True, index=True)  # widget
    retell_agent_id: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    retell_sincronizado: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    archivado: Mapped[bool] = mapped_column(Boolean, default=False)
    creado: Mapped[datetime] = _creado()
    actualizado: Mapped[datetime] = mapped_column(DateTime, default=ahora, onupdate=ahora)


class AgenteVersion(Base):
    __tablename__ = "agente_versiones"
    __table_args__ = (UniqueConstraint("agente_id", "numero"),)
    id: Mapped[int] = _id()
    agente_id: Mapped[int] = _fk("agentes")
    numero: Mapped[int] = mapped_column(Integer)
    config: Mapped[dict] = mapped_column(JSON)
    nota: Mapped[str] = mapped_column(String(300), default="")
    publicado_por: Mapped[int | None] = _fk("usuarios", nulo=True, borrar="SET NULL")
    creado: Mapped[datetime] = _creado()


# ─────────────────────────────────── Contactos ───────────────────────────────────

class Contacto(Base):
    __tablename__ = "contactos"
    __table_args__ = (
        UniqueConstraint("espacio_id", "telefono"),
        Index("ix_contacto_email", "espacio_id", "email"),
    )
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    nombre: Mapped[str] = mapped_column(String(200), default="")
    telefono: Mapped[str | None] = mapped_column(String(32), nullable=True)  # E.164
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    empresa: Mapped[str] = mapped_column(String(200), default="")
    zona_horaria: Mapped[str | None] = mapped_column(String(64), nullable=True)
    etapa: Mapped[str] = mapped_column(String(40), default="nuevo")
    atributos: Mapped[dict] = mapped_column(JSON, default=dict)  # variables libres para {{var}}
    datos_ia: Mapped[dict] = mapped_column(JSON, default=dict)  # análisis persistente y datos guardados por el agente
    etiquetas: Mapped[list] = mapped_column(JSON, default=list)
    opt_out_whatsapp: Mapped[bool] = mapped_column(Boolean, default=False)
    opt_out_llamadas: Mapped[bool] = mapped_column(Boolean, default=False)
    opt_out_correo: Mapped[bool] = mapped_column(Boolean, default=False)
    ultimo_contacto_en: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    creado: Mapped[datetime] = _creado()


# ───────────────────────────── Canales: WhatsApp y voz ─────────────────────────────

class LineaWhatsapp(Base):
    __tablename__ = "lineas_whatsapp"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    phone_number_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    waba_id: Mapped[str] = mapped_column(String(40))
    numero_visible: Mapped[str] = mapped_column(String(40), default="")
    nombre_verificado: Mapped[str] = mapped_column(String(200), default="")
    token_cifrado: Mapped[str] = mapped_column(Text, default="")  # token del negocio (Embedded Signup) o system user
    agente_id: Mapped[int | None] = _fk("agentes", nulo=True, borrar="SET NULL")
    calidad: Mapped[str] = mapped_column(String(16), default="GREEN")  # GREEN | YELLOW | RED | UNKNOWN
    tier: Mapped[str] = mapped_column(String(32), default="TIER_250")
    estado: Mapped[str] = mapped_column(String(20), default="conectada")
    coexistencia: Mapped[bool] = mapped_column(Boolean, default=False)
    tope_diario_manual: Mapped[int | None] = mapped_column(Integer, nullable=True)
    calentamiento_desde: Mapped[datetime] = mapped_column(DateTime, default=ahora)
    marketing_pausado: Mapped[bool] = mapped_column(Boolean, default=False)
    calidad_revisada_en: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    creado: Mapped[datetime] = _creado()


class Plantilla(Base):
    __tablename__ = "plantillas"
    __table_args__ = (UniqueConstraint("linea_id", "nombre", "idioma"),)
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    linea_id: Mapped[int] = _fk("lineas_whatsapp")
    nombre: Mapped[str] = mapped_column(String(200))
    idioma: Mapped[str] = mapped_column(String(10), default="es")
    categoria: Mapped[str] = mapped_column(String(20), default="MARKETING")  # MARKETING | UTILITY | AUTHENTICATION
    estado: Mapped[str] = mapped_column(String(20), default="PENDING")
    componentes: Mapped[list] = mapped_column(JSON, default=list)
    cuerpo: Mapped[str] = mapped_column(Text, default="")
    n_variables: Mapped[int] = mapped_column(Integer, default=0)
    carpeta: Mapped[str] = mapped_column(String(80), default="")
    meta_id: Mapped[str | None] = mapped_column(String(60), nullable=True)
    motivo_rechazo: Mapped[str] = mapped_column(String(300), default="")
    creado: Mapped[datetime] = _creado()


class TroncalSip(Base):
    __tablename__ = "troncales_sip"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    nombre: Mapped[str] = mapped_column(String(120))
    termination_uri: Mapped[str] = mapped_column(String(300))
    usuario: Mapped[str] = mapped_column(String(120), default="")
    clave_cifrada: Mapped[str] = mapped_column(Text, default="")
    canales: Mapped[int] = mapped_column(Integer, default=10)
    creado: Mapped[datetime] = _creado()


class NumeroTelefono(Base):
    __tablename__ = "numeros"
    __table_args__ = (UniqueConstraint("espacio_id", "numero"),)
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    numero: Mapped[str] = mapped_column(String(32))
    etiqueta: Mapped[str] = mapped_column(String(120), default="")
    proveedor: Mapped[str] = mapped_column(String(20), default="sip")  # sip | retell | twilio
    troncal_id: Mapped[int | None] = _fk("troncales_sip", nulo=True, borrar="SET NULL")
    agente_entrante_id: Mapped[int | None] = _fk("agentes", nulo=True, borrar="SET NULL")
    importado_retell: Mapped[bool] = mapped_column(Boolean, default=False)
    tope_diario: Mapped[int] = mapped_column(Integer, default=150)  # proteger el caller ID
    activo: Mapped[bool] = mapped_column(Boolean, default=True)
    creado: Mapped[datetime] = _creado()


# ─────────────────────────── Conversaciones (todos los canales) ───────────────────────────

CANALES = ("whatsapp", "widget", "voz", "correo", "sms", "playground", "simulador")


class Conversacion(Base):
    __tablename__ = "conversaciones"
    __table_args__ = (Index("ix_conv_estado", "espacio_id", "estado", "ultimo_mensaje_en"),)
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    contacto_id: Mapped[int | None] = _fk("contactos", nulo=True)
    agente_id: Mapped[int | None] = _fk("agentes", nulo=True, borrar="SET NULL")
    canal: Mapped[str] = mapped_column(String(20))
    linea_id: Mapped[int | None] = _fk("lineas_whatsapp", nulo=True, borrar="SET NULL")
    estado: Mapped[str] = mapped_column(String(24), default="abierta")  # abierta | esperando_humano | cerrada
    ia_activa: Mapped[bool] = mapped_column(Boolean, default=True)
    asignado_a: Mapped[int | None] = _fk("usuarios", nulo=True, borrar="SET NULL")
    motivo_escalado: Mapped[str] = mapped_column(String(300), default="")
    ultimo_mensaje_en: Mapped[datetime] = mapped_column(DateTime, default=ahora)
    ultimo_entrante_en: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # ventana 24 h
    ultimo_ia_en: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    seguimientos_enviados: Mapped[int] = mapped_column(Integer, default=0)
    no_leidos: Mapped[int] = mapped_column(Integer, default=0)
    variables: Mapped[dict] = mapped_column(JSON, default=dict)
    resumen: Mapped[str] = mapped_column(Text, default="")
    analisis: Mapped[dict] = mapped_column(JSON, default=dict)
    exito: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    sentimiento: Mapped[str] = mapped_column(String(16), default="")
    calificacion: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 👍 1 / 👎 -1
    tokens_entrada: Mapped[int] = mapped_column(Integer, default=0)
    tokens_salida: Mapped[int] = mapped_column(Integer, default=0)
    costo_usd: Mapped[float] = mapped_column(Float, default=0.0)
    inscripcion_id: Mapped[int | None] = _fk("inscripciones", nulo=True, borrar="SET NULL")
    creado: Mapped[datetime] = _creado()
    cerrado_en: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    contacto: Mapped[Contacto | None] = relationship(lazy="joined")
    asignado: Mapped[Usuario | None] = relationship(lazy="joined")


class Mensaje(Base):
    __tablename__ = "mensajes"
    id: Mapped[int] = _id()
    conversacion_id: Mapped[int] = _fk("conversaciones")
    direccion: Mapped[str] = mapped_column(String(10))  # entrante | saliente | interno
    autor: Mapped[str] = mapped_column(String(12))  # contacto | ia | humano | sistema
    tipo: Mapped[str] = mapped_column(String(16), default="texto")  # texto | plantilla | media | herramienta | nota
    contenido: Mapped[str] = mapped_column(Text, default="")
    datos: Mapped[dict] = mapped_column(JSON, default=dict)
    wamid: Mapped[str | None] = mapped_column(String(160), nullable=True, unique=True)
    estado_entrega: Mapped[str] = mapped_column(String(16), default="")  # enviado | entregado | leido | fallido
    error: Mapped[str] = mapped_column(String(500), default="")
    autor_usuario_id: Mapped[int | None] = _fk("usuarios", nulo=True, borrar="SET NULL")
    calificacion: Mapped[int | None] = mapped_column(Integer, nullable=True)
    creado: Mapped[datetime] = _creado()


class Llamada(Base):
    __tablename__ = "llamadas"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    conversacion_id: Mapped[int | None] = _fk("conversaciones", nulo=True)
    contacto_id: Mapped[int | None] = _fk("contactos", nulo=True)
    agente_id: Mapped[int | None] = _fk("agentes", nulo=True, borrar="SET NULL")
    inscripcion_id: Mapped[int | None] = _fk("inscripciones", nulo=True, borrar="SET NULL")
    retell_call_id: Mapped[str | None] = mapped_column(String(80), unique=True, nullable=True)
    tipo: Mapped[str] = mapped_column(String(12), default="telefono")  # telefono | web
    direccion: Mapped[str] = mapped_column(String(10), default="saliente")
    desde: Mapped[str] = mapped_column(String(32), default="")
    hacia: Mapped[str] = mapped_column(String(32), default="")
    estado: Mapped[str] = mapped_column(String(16), default="registrada")  # registrada | en_curso | terminada | fallida
    resultado: Mapped[str] = mapped_column(String(16), default="")  # contestada | no_contesta | ocupado | buzon | fallida
    razon_desconexion: Mapped[str] = mapped_column(String(60), default="")
    paso_idx: Mapped[int | None] = mapped_column(Integer, nullable=True)
    intento: Mapped[int] = mapped_column(Integer, default=1)
    duracion_s: Mapped[int] = mapped_column(Integer, default=0)
    grabacion_url: Mapped[str] = mapped_column(String(500), default="")
    latencia_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    costo_usd: Mapped[float] = mapped_column(Float, default=0.0)
    datos: Mapped[dict] = mapped_column(JSON, default=dict)
    creado: Mapped[datetime] = _creado()
    inicio: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    fin: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Cita(Base):
    __tablename__ = "citas"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    contacto_id: Mapped[int | None] = _fk("contactos", nulo=True)
    agente_id: Mapped[int | None] = _fk("agentes", nulo=True, borrar="SET NULL")
    conversacion_id: Mapped[int | None] = _fk("conversaciones", nulo=True, borrar="SET NULL")
    inicio: Mapped[datetime] = mapped_column(DateTime)
    duracion_min: Mapped[int] = mapped_column(Integer, default=30)
    estado: Mapped[str] = mapped_column(String(16), default="confirmada")
    proveedor: Mapped[str] = mapped_column(String(16), default="interno")  # interno | calcom
    externo_id: Mapped[str] = mapped_column(String(120), default="")
    notas: Mapped[str] = mapped_column(Text, default="")
    creado: Mapped[datetime] = _creado()


# ─────────────────────────────── Conocimiento (Brains) ───────────────────────────────

class Cerebro(Base):
    __tablename__ = "cerebros"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    nombre: Mapped[str] = mapped_column(String(80))
    descripcion: Mapped[str] = mapped_column(Text, default="")
    creado: Mapped[datetime] = _creado()


class Fuente(Base):
    __tablename__ = "fuentes"
    id: Mapped[int] = _id()
    cerebro_id: Mapped[int] = _fk("cerebros")
    tipo: Mapped[str] = mapped_column(String(12))  # url | sitemap | archivo | texto
    nombre: Mapped[str] = mapped_column(String(300))
    url: Mapped[str] = mapped_column(String(1000), default="")
    texto: Mapped[str] = mapped_column(Text, default="")  # texto pegado o extraído
    archivo: Mapped[str] = mapped_column(String(500), default="")
    estado: Mapped[str] = mapped_column(String(12), default="pendiente")  # pendiente | procesando | lista | fallida
    error: Mapped[str] = mapped_column(String(500), default="")
    n_fragmentos: Mapped[int] = mapped_column(Integer, default=0)
    opciones: Mapped[dict] = mapped_column(JSON, default=dict)  # p. ej. max_paginas del sitemap
    actualizado: Mapped[datetime] = mapped_column(DateTime, default=ahora, onupdate=ahora)
    creado: Mapped[datetime] = _creado()


class Fragmento(Base):
    __tablename__ = "fragmentos"
    id: Mapped[int] = _id()
    cerebro_id: Mapped[int] = _fk("cerebros")
    fuente_id: Mapped[int] = _fk("fuentes")
    orden: Mapped[int] = mapped_column(Integer, default=0)
    texto: Mapped[str] = mapped_column(Text)
    titulo: Mapped[str] = mapped_column(String(300), default="")
    url: Mapped[str] = mapped_column(String(1000), default="")
    embedding: Mapped[bytes] = mapped_column(LargeBinary)  # float32 normalizado
    modelo: Mapped[str] = mapped_column(String(80), default="")


# ─────────────────────────────── Secuencias (campañas) ───────────────────────────────

class Secuencia(Base):
    """Campaña multicanal: lista ordenada de pasos (llamada, WhatsApp, correo, espera).

    Un solo motor reemplaza las "Voice Sequence" y "Text Sequence" de Dapta y sus
    fallbacks cruzados: el fallback es simplemente el siguiente paso con condición.
    """
    __tablename__ = "secuencias"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    nombre: Mapped[str] = mapped_column(String(160))
    estado: Mapped[str] = mapped_column(String(16), default="borrador")  # borrador | activa | pausada | completada | archivada
    pasos: Mapped[list] = mapped_column(JSON, default=list)
    zona_horaria: Mapped[str] = mapped_column(String(64), default="America/Bogota")
    usar_zona_contacto: Mapped[bool] = mapped_column(Boolean, default=True)
    horario: Mapped[dict] = mapped_column(JSON, default=dict)  # {"lun": [["09:00","12:00"],["14:00","18:00"]], ...}
    ab_agentes: Mapped[dict] = mapped_column(JSON, default=dict)  # {"agente_id": peso}
    numeros_ids: Mapped[list] = mapped_column(JSON, default=list)  # rotación de caller ID
    linea_id: Mapped[int | None] = _fk("lineas_whatsapp", nulo=True, borrar="SET NULL")
    tamano_lote: Mapped[int] = mapped_column(Integer, default=100)
    segundos_entre_llamadas: Mapped[int] = mapped_column(Integer, default=3)
    detener_al_responder: Mapped[bool] = mapped_column(Boolean, default=True)
    detener_al_agendar: Mapped[bool] = mapped_column(Boolean, default=True)
    fecha_fin: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ultimo_envio_llamada: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    creado: Mapped[datetime] = _creado()


class Inscripcion(Base):
    __tablename__ = "inscripciones"
    __table_args__ = (
        UniqueConstraint("secuencia_id", "contacto_id"),
        Index("ix_insc_proximo", "estado", "proximo_en"),
    )
    id: Mapped[int] = _id()
    secuencia_id: Mapped[int] = _fk("secuencias")
    contacto_id: Mapped[int] = _fk("contactos")
    estado: Mapped[str] = mapped_column(String(16), default="activa")
    # activa | esperando (resultado de llamada) | completada | detenida | respondio | agendo | fallida | baja
    paso: Mapped[int] = mapped_column(Integer, default=0)
    proximo_en: Mapped[datetime] = mapped_column(DateTime, default=ahora)
    intentos_paso: Mapped[int] = mapped_column(Integer, default=0)
    intentos_hoy: Mapped[int] = mapped_column(Integer, default=0)
    dia_intentos: Mapped[str] = mapped_column(String(10), default="")
    agente_id: Mapped[int | None] = _fk("agentes", nulo=True, borrar="SET NULL")  # asignado por A/B
    conecto: Mapped[bool] = mapped_column(Boolean, default=False)
    respondio: Mapped[bool] = mapped_column(Boolean, default=False)
    variables: Mapped[dict] = mapped_column(JSON, default=dict)
    historial: Mapped[list] = mapped_column(JSON, default=list)
    ultimo_error: Mapped[str] = mapped_column(String(500), default="")
    bloqueado_hasta: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    creado: Mapped[datetime] = _creado()
    contacto: Mapped[Contacto] = relationship(lazy="joined")


class Envio(Base):
    """Registro de cada salida proactiva: alimenta topes diarios, dedupe 24 h y cooldown."""
    __tablename__ = "envios"
    __table_args__ = (Index("ix_envio_contacto", "contacto_id", "canal", "creado"),
                      Index("ix_envio_linea", "linea_id", "creado"))
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    contacto_id: Mapped[int] = _fk("contactos")
    canal: Mapped[str] = mapped_column(String(16))  # whatsapp | llamada | correo
    linea_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    numero_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    categoria: Mapped[str] = mapped_column(String(20), default="")
    secuencia_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    creado: Mapped[datetime] = _creado()


# ─────────────────────────── Calidad: simulaciones ───────────────────────────

class Simulacion(Base):
    __tablename__ = "simulaciones"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    agente_id: Mapped[int] = _fk("agentes")
    nombre: Mapped[str] = mapped_column(String(160))
    escenarios: Mapped[list] = mapped_column(JSON, default=list)
    rubrica: Mapped[list] = mapped_column(JSON, default=list)
    max_turnos: Mapped[int] = mapped_column(Integer, default=8)
    estado: Mapped[str] = mapped_column(String(16), default="pendiente")  # pendiente | corriendo | lista | fallida
    resultados: Mapped[list] = mapped_column(JSON, default=list)
    puntaje: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str] = mapped_column(String(500), default="")
    usar_borrador: Mapped[bool] = mapped_column(Boolean, default=True)
    creado: Mapped[datetime] = _creado()


# ─────────────────────────── Eventos y webhooks salientes ───────────────────────────

class Evento(Base):
    __tablename__ = "eventos"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    tipo: Mapped[str] = mapped_column(String(60), index=True)
    datos: Mapped[dict] = mapped_column(JSON, default=dict)
    creado: Mapped[datetime] = _creado()


class SuscripcionWebhook(Base):
    __tablename__ = "suscripciones_webhook"
    id: Mapped[int] = _id()
    espacio_id: Mapped[int] = _fk("espacios")
    url: Mapped[str] = mapped_column(String(1000))
    eventos: Mapped[list] = mapped_column(JSON, default=list)  # ["*"] o tipos
    secreto: Mapped[str] = mapped_column(String(80))
    activa: Mapped[bool] = mapped_column(Boolean, default=True)
    creado: Mapped[datetime] = _creado()


class EntregaWebhook(Base):
    __tablename__ = "entregas_webhook"
    __table_args__ = (Index("ix_entrega_pend", "estado", "proximo_intento"),)
    id: Mapped[int] = _id()
    suscripcion_id: Mapped[int] = _fk("suscripciones_webhook")
    evento_id: Mapped[int] = _fk("eventos")
    estado: Mapped[str] = mapped_column(String(12), default="pendiente")  # pendiente | ok | fallida
    intentos: Mapped[int] = mapped_column(Integer, default=0)
    proximo_intento: Mapped[datetime] = mapped_column(DateTime, default=ahora)
    respuesta: Mapped[str] = mapped_column(String(500), default="")
    creado: Mapped[datetime] = _creado()


class Bloqueo(Base):
    """Candado simple en base de datos para que solo una instancia corra cada tarea."""
    __tablename__ = "bloqueos"
    nombre: Mapped[str] = mapped_column(String(60), primary_key=True)
    hasta: Mapped[datetime] = mapped_column(DateTime)
    duenio: Mapped[str] = mapped_column(String(60), default="")
