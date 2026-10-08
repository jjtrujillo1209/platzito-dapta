"""Esquema de configuración de un agente (se guarda como JSON en borrador/publicada)."""
from typing import Literal

from pydantic import BaseModel, Field

TipoHerramienta = Literal[
    "buscar_conocimiento", "agendar_cita", "enviar_plantilla_whatsapp", "transferir_llamada", "colgar",
    "escalar_humano", "guardar_dato", "api",
]


class Parametro(BaseModel):
    nombre: str
    tipo: Literal["texto", "numero", "booleano", "fecha", "email", "telefono", "enum"] = "texto"
    descripcion: str = ""
    requerido: bool = True
    opciones: list[str] = []


class Herramienta(BaseModel):
    tipo: TipoHerramienta
    nombre: str = ""  # nombre que ve el LLM; por defecto el tipo
    descripcion: str = ""
    activa: bool = True
    # api: {"metodo","url","encabezados","cuerpo_plantilla"}; transferir: {"numero"}; plantilla: {"plantilla_id","linea_id"}
    # agendar: {"proveedor": "interno"|"calcom", "duracion_min", "zona_horaria", "horario"}
    config: dict = {}
    parametros: list[Parametro] = []
    mensaje_espera: str = ""  # lo que dice la voz mientras corre (p. ej. "Déjame revisar…")


class Modelo(BaseModel):
    proveedor: str = ""  # vacío = el de la instancia
    nombre: str = ""
    temperatura: float = Field(0.4, ge=0, le=1.5)
    max_tokens: int = 600


class Conocimiento(BaseModel):
    cerebro_ids: list[int] = []
    top_k: int = Field(4, ge=1, le=12)
    umbral: float = Field(0.35, ge=0, le=1)
    mostrar_fuentes: bool = False


class Seguimiento(BaseModel):
    tras_min: int = Field(60, ge=5, le=1440)
    tipo: Literal["estatico", "ia"] = "ia"
    contenido: str = ""  # texto fijo o instrucción para la IA


class Conversacion(BaseModel):
    cierre_inactividad_min: int = Field(60, ge=10, le=1440)
    demora_respuesta_s: float = Field(0, ge=0, le=60)
    partir_respuestas: bool = True
    seguimientos: list[Seguimiento] = []
    palabras_baja: list[str] = ["baja", "stop", "no me escriban", "no me interesa que me escriban"]


class Buzon(BaseModel):
    detectar: bool = True
    accion: Literal["colgar", "mensaje"] = "colgar"
    mensaje: str = ""


class Voz(BaseModel):
    voz_id: str = "11labs-Adrian"
    idioma: str = "es-419"
    velocidad: float = Field(1.0, ge=0.5, le=2)
    temperatura_voz: float = Field(1.0, ge=0, le=2)
    volumen: float = Field(1.0, ge=0, le=2)
    sensibilidad_interrupcion: float = Field(1.0, ge=0, le=1)
    reactividad: float = Field(1.0, ge=0, le=1)
    backchannel: bool = True
    palabras_clave: list[str] = []
    sonido_ambiente: str | None = None
    fin_silencio_ms: int = Field(20000, ge=10000, le=600000)
    duracion_max_ms: int = Field(900000, ge=60000, le=7200000)
    recordatorio_ms: int = 10000
    recordatorio_max: int = 1
    buzon: Buzon = Buzon()
    numero_transferencia: str = ""
    dtmf: bool = False  # permitir que el contacto marque dígitos


class CampoAnalisis(BaseModel):
    nombre: str
    tipo: Literal["texto", "numero", "booleano", "enum"] = "texto"
    descripcion: str = ""
    opciones: list[str] = []
    requerido: bool = False
    alcance: Literal["sesion", "persistente"] = "sesion"  # persistente se acumula en el contacto


class Analisis(BaseModel):
    activo: bool = True
    resumen_prompt: str = "Resume la conversación en 2-3 frases: qué quería el contacto y cómo terminó."
    exito_prompt: str = "¿Se logró el objetivo del agente (p. ej. agendar, calificar o resolver)?"
    campos: list[CampoAnalisis] = []
    etapa_si_exito: str = ""
    etapa_si_fracaso: str = ""


class ConfigAgente(BaseModel):
    proposito: str = ""
    instrucciones: str = "Eres un asistente amable y conciso. Responde en español."
    mensaje_inicial: str = ""  # vacío en voz = espera a que hable el contacto
    quien_habla_primero: Literal["agente", "contacto"] = "agente"
    usar_contexto_empresa: bool = True
    variables: dict[str, str] = {}  # valores por defecto de {{var}}
    modelo: Modelo = Modelo()
    conocimiento: Conocimiento = Conocimiento()
    herramientas: list[Herramienta] = [
        Herramienta(tipo="buscar_conocimiento"),
        Herramienta(tipo="escalar_humano"),
        Herramienta(tipo="colgar"),
    ]
    conversacion: Conversacion = Conversacion()
    voz: Voz = Voz()
    analisis: Analisis = Analisis()
    guardas: dict = {"escalar_si_pide_humano": True, "colgar_en_despedida": True, "max_rondas_herramientas": 4}


def normalizar(config: dict | None) -> dict:
    """Valida y completa con valores por defecto."""
    return ConfigAgente.model_validate(config or {}).model_dump()
