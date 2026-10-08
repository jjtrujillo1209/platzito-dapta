"""Configuración global leída del entorno (.env).

Las credenciales de proveedores (Anthropic, Retell, Meta, SMTP, Cal.com) pueden
venir de aquí como valor por defecto de la instancia, o configurarse por
espacio de trabajo desde Ajustes → Integraciones (se guardan cifradas).
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

RAIZ = Path(__file__).resolve().parent.parent


class Ajustes(BaseSettings):
    model_config = SettingsConfigDict(env_file=RAIZ / ".env", extra="ignore")

    entorno: str = "desarrollo"  # desarrollo | produccion
    url_publica: str = "http://localhost:8700"  # URL pública estable (webhooks y WS de voz)
    url_frontend: str = "http://localhost:5173"
    database_url: str = f"sqlite:///{RAIZ / 'datos' / 'platzito.db'}"
    directorio_datos: Path = RAIZ / "datos"

    # Seguridad
    clave_secreta: str = "cambiar-en-produccion-esta-clave-larga"
    clave_cifrado: str = ""  # Fernet; si falta se deriva de clave_secreta
    minutos_sesion: int = 60 * 24 * 7
    secreto_tick: str = ""  # para POST /interno/tick desde un cron externo

    # LLM por defecto de la instancia
    llm_proveedor: str = "anthropic"  # anthropic | openai | ollama | groq | gemini
    llm_modelo: str = "claude-sonnet-5-5"
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    groq_api_key: str = ""
    gemini_api_key: str = ""
    ollama_url: str = "http://localhost:11434"

    # Embeddings (nunca falsos en producción)
    embeddings_proveedor: str = "ollama"  # ollama | openai
    embeddings_modelo: str = "nomic-embed-text"

    # Voz
    retell_api_key: str = ""

    # WhatsApp (Meta Cloud API, conexión directa como Tech Provider)
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_config_id: str = ""  # configuración de Embedded Signup
    meta_verify_token: str = "platzito-verify"
    meta_graph_version: str = "v23.0"

    # Correo saliente
    smtp_host: str = ""
    smtp_puerto: int = 587
    smtp_usuario: str = ""
    smtp_clave: str = ""
    smtp_remitente: str = ""

    # Planificador interno (se puede apagar si se usa un cron externo)
    planificador_activo: bool = True
    planificador_intervalo_s: int = 30

    @property
    def es_produccion(self) -> bool:
        return self.entorno == "produccion"


@lru_cache
def ajustes() -> Ajustes:
    a = Ajustes()
    a.directorio_datos.mkdir(parents=True, exist_ok=True)
    return a
