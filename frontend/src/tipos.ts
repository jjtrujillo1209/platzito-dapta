// Tipos de la API (espejo de backend/app/serial.py y backend/app/cerebro/config.py).

export type Rol = "propietario" | "admin" | "editor" | "operador" | "lector";
export const NIVEL_ROL: Record<Rol, number> = { propietario: 5, admin: 4, editor: 3, operador: 2, lector: 1 };

export interface Sesion {
  token: string;
  usuario: { id: number; nombre: string; email: string };
  espacios: { id: number; nombre: string; rol: Rol }[];
}

export interface Espacio {
  id: number;
  nombre: string;
  zona_horaria: string;
  plan: string;
  concurrencia_llamadas: number;
  contexto_empresa: string;
  rol: Rol;
}

export type TipoHerramienta =
  | "buscar_conocimiento"
  | "agendar_cita"
  | "enviar_plantilla_whatsapp"
  | "transferir_llamada"
  | "colgar"
  | "escalar_humano"
  | "guardar_dato"
  | "api";

export interface Parametro {
  nombre: string;
  tipo: "texto" | "numero" | "booleano" | "fecha" | "email" | "telefono" | "enum";
  descripcion: string;
  requerido: boolean;
  opciones: string[];
}

export interface Herramienta {
  tipo: TipoHerramienta;
  nombre: string;
  descripcion: string;
  activa: boolean;
  config: Record<string, any>;
  parametros: Parametro[];
  mensaje_espera: string;
}

export interface CampoAnalisis {
  nombre: string;
  tipo: "texto" | "numero" | "booleano" | "enum";
  descripcion: string;
  opciones: string[];
  requerido: boolean;
  alcance: "sesion" | "persistente";
}

export interface ConfigAgente {
  proposito: string;
  instrucciones: string;
  mensaje_inicial: string;
  quien_habla_primero: "agente" | "contacto";
  usar_contexto_empresa: boolean;
  variables: Record<string, string>;
  modelo: { proveedor: string; nombre: string; temperatura: number; max_tokens: number };
  conocimiento: { cerebro_ids: number[]; top_k: number; umbral: number; mostrar_fuentes: boolean };
  herramientas: Herramienta[];
  conversacion: {
    cierre_inactividad_min: number;
    demora_respuesta_s: number;
    partir_respuestas: boolean;
    seguimientos: { tras_min: number; tipo: "estatico" | "ia"; contenido: string }[];
    palabras_baja: string[];
  };
  voz: {
    voz_id: string;
    idioma: string;
    velocidad: number;
    temperatura_voz: number;
    volumen: number;
    sensibilidad_interrupcion: number;
    reactividad: number;
    backchannel: boolean;
    palabras_clave: string[];
    sonido_ambiente: string | null;
    fin_silencio_ms: number;
    duracion_max_ms: number;
    recordatorio_ms: number;
    recordatorio_max: number;
    buzon: { detectar: boolean; accion: "colgar" | "mensaje"; mensaje: string };
    numero_transferencia: string;
    dtmf: boolean;
  };
  analisis: {
    activo: boolean;
    resumen_prompt: string;
    exito_prompt: string;
    campos: CampoAnalisis[];
    etapa_si_exito: string;
    etapa_si_fracaso: string;
  };
  guardas: { escalar_si_pide_humano: boolean; colgar_en_despedida: boolean; max_rondas_herramientas: number };
}

export interface Agente {
  id: number;
  nombre: string;
  descripcion: string;
  version_publicada: number;
  publicado: boolean;
  clave_publica: string;
  retell_agent_id: string | null;
  retell_sincronizado: string | null;
  cambios_sin_publicar: boolean;
  creado: string;
  actualizado: string;
  config?: ConfigAgente;
  config_publicada?: ConfigAgente | null;
  aviso?: string | null;
}

export interface Contacto {
  id: number;
  nombre: string;
  telefono: string | null;
  email: string | null;
  empresa: string;
  zona_horaria: string | null;
  etapa: string;
  atributos: Record<string, string>;
  datos_ia: Record<string, unknown>;
  etiquetas: string[];
  opt_out_whatsapp: boolean;
  opt_out_llamadas: boolean;
  opt_out_correo: boolean;
  ultimo_contacto_en: string | null;
  creado: string;
}

export type Canal = "whatsapp" | "widget" | "voz" | "correo" | "sms" | "playground" | "simulador";

export interface Mensaje {
  id: number;
  conversacion_id: number;
  direccion: "entrante" | "saliente" | "interno";
  autor: "contacto" | "ia" | "humano" | "sistema";
  tipo: "texto" | "plantilla" | "media" | "herramienta" | "nota";
  contenido: string;
  datos: Record<string, any>;
  estado_entrega: string;
  error: string;
  calificacion: number | null;
  autor_usuario_id: number | null;
  creado: string;
}

export interface Conversacion {
  id: number;
  canal: Canal;
  estado: "abierta" | "esperando_humano" | "cerrada";
  ia_activa: boolean;
  asignado_a: number | null;
  asignado_nombre: string | null;
  agente_id: number | null;
  linea_id: number | null;
  motivo_escalado: string;
  contacto: Contacto | null;
  no_leidos: number;
  ultimo_mensaje_en: string;
  ultimo_entrante_en: string | null;
  resumen: string;
  analisis: Record<string, unknown>;
  exito: boolean | null;
  sentimiento: string;
  calificacion: number | null;
  costo_usd: number;
  tokens: number;
  inscripcion_id: number | null;
  creado: string;
  cerrado_en: string | null;
  ultimo_mensaje?: { contenido: string; autor: string; tipo: string };
  mensajes?: Mensaje[];
  ventana_24h?: { abierta: boolean; cierra_en: string } | null;
}

export interface Llamada {
  id: number;
  conversacion_id: number | null;
  contacto_id: number | null;
  agente_id: number | null;
  inscripcion_id: number | null;
  retell_call_id: string | null;
  tipo: "telefono" | "web";
  direccion: string;
  desde: string;
  hacia: string;
  estado: string;
  resultado: "" | "contestada" | "no_contesta" | "ocupado" | "buzon" | "fallida";
  razon_desconexion: string;
  intento: number;
  duracion_s: number;
  grabacion_url: string;
  latencia_ms: number | null;
  costo_usd: number;
  creado: string;
  inicio: string | null;
  fin: string | null;
  contacto?: Contacto | null;
  resumen?: string;
  exito?: boolean | null;
  sentimiento?: string;
}

export interface Fuente {
  id: number;
  cerebro_id: number;
  tipo: "url" | "sitemap" | "archivo" | "texto";
  nombre: string;
  url: string;
  estado: "pendiente" | "procesando" | "lista" | "fallida";
  error: string;
  n_fragmentos: number;
  opciones: Record<string, unknown>;
  actualizado: string;
  creado: string;
}

export interface Cerebro {
  id: number;
  nombre: string;
  descripcion: string;
  creado: string;
  fuentes?: Fuente[];
  n_fuentes?: number;
  n_fragmentos?: number;
}

export interface Linea {
  id: number;
  phone_number_id: string;
  waba_id: string;
  numero_visible: string;
  nombre_verificado: string;
  agente_id: number | null;
  calidad: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  tier: string;
  estado: string;
  coexistencia: boolean;
  tope_diario_manual: number | null;
  marketing_pausado: boolean;
  calentamiento_desde: string;
  calidad_revisada_en: string | null;
  tope_24h: number | null;
  enviados_24h: number | null;
  creado: string;
}

export interface Plantilla {
  id: number;
  linea_id: number;
  nombre: string;
  idioma: string;
  categoria: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  estado: string;
  cuerpo: string;
  n_variables: number;
  carpeta: string;
  componentes: unknown[];
  motivo_rechazo: string;
  creado: string;
}

export interface Troncal {
  id: number;
  nombre: string;
  termination_uri: string;
  usuario: string;
  tiene_clave: boolean;
  canales: number;
  creado: string;
}

export interface Numero {
  id: number;
  numero: string;
  etiqueta: string;
  proveedor: "sip" | "retell" | "twilio";
  troncal_id: number | null;
  agente_entrante_id: number | null;
  importado_retell: boolean;
  tope_diario: number;
  activo: boolean;
  usados_24h: number | null;
  creado: string;
}

export type TipoPaso = "llamada" | "whatsapp" | "correo" | "esperar";

export interface Paso {
  tipo: TipoPaso;
  espera_min: number;
  condicion: "siempre" | "sin_respuesta" | "no_conecto";
  agente_id: number | null;
  max_intentos: number;
  intentos_por_dia: number;
  reintento_min: number;
  whatsapp_tras_intento: number | null;
  plantilla_fallback_id: number | null;
  plantilla_id: number | null;
  variables: string[];
  texto: string;
  asunto: string;
  cuerpo: string;
}

export interface Secuencia {
  id: number;
  nombre: string;
  estado: "borrador" | "activa" | "pausada" | "completada" | "archivada";
  pasos: Paso[];
  zona_horaria: string;
  usar_zona_contacto: boolean;
  horario: Record<string, [string, string][]>;
  ab_agentes: Record<string, number>;
  numeros_ids: number[];
  linea_id: number | null;
  tamano_lote: number;
  segundos_entre_llamadas: number;
  detener_al_responder: boolean;
  detener_al_agendar: boolean;
  fecha_fin: string | null;
  conteos: Record<string, number>;
  creado: string;
}

export interface Inscripcion {
  id: number;
  secuencia_id: number;
  contacto: Contacto | null;
  estado: string;
  paso: number;
  proximo_en: string;
  intentos_paso: number;
  agente_id: number | null;
  conecto: boolean;
  respondio: boolean;
  historial: { t: string; paso: number; evento: string; [k: string]: unknown }[];
  ultimo_error: string;
  creado: string;
}

export interface Simulacion {
  id: number;
  agente_id: number;
  nombre: string;
  estado: "pendiente" | "corriendo" | "lista" | "fallida";
  puntaje: number | null;
  error: string;
  max_turnos: number;
  usar_borrador: boolean;
  n_escenarios: number;
  n_resultados: number;
  creado: string;
  escenarios?: { nombre: string; persona: string; comportamiento: string; objetivo: string; canal: string }[];
  rubrica?: string[];
  resultados?: {
    escenario: { nombre: string; persona: string; comportamiento: string; objetivo: string; canal: string };
    transcript: { rol: "agente" | "contacto"; texto: string; herramientas?: { nombre: string; args: unknown; resultado: string }[] }[];
    fin: string;
    costo: number;
    evaluacion: {
      puntaje: number;
      objetivo_cumplido: boolean;
      criterios: { criterio: string; puntaje: number; comentario: string }[];
      problemas: string[];
      sugerencias_prompt: string[];
    };
  }[];
}

export interface Metricas {
  rango: { desde: string; hasta: string };
  conversaciones: {
    total: number;
    contactos_unicos: number;
    por_canal: Record<string, number>;
    exitosas: number;
    analizadas: number;
    tasa_exito: number;
    escaladas: number;
    mensajes_ia: number;
    pulgar_arriba: number;
    pulgar_abajo: number;
  };
  llamadas: {
    total: number;
    contestadas: number;
    tasa_conexion: number;
    duracion_promedio_s: number;
    minutos_totales: number;
    contactos_unicos: number;
    latencia_promedio_ms: number | null;
    por_razon: Record<string, number>;
    por_resultado: Record<string, number>;
  };
  citas: number;
  envios: Record<string, number>;
  costo_usd: number;
  serie: { dia: string; conversaciones: number; llamadas: number; contestadas: number }[];
  por_agente: { agente_id: number | null; nombre: string; conversaciones: number; exitosas: number; costo_usd: number }[];
  lineas: { id: number; numero: string; calidad: string; tier: string; marketing_pausado: boolean }[];
}
