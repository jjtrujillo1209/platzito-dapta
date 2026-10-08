// Piezas compartidas de las pantallas de campañas (secuencias).
import type { Paso, Secuencia, TipoPaso } from "../tipos";
import { Icono, type TonoInsignia } from "./ui";

export const TIPOS_PASO: Record<TipoPaso, { texto: string; icono: string }> = {
  llamada: { texto: "Llamada", icono: "call" },
  whatsapp: { texto: "WhatsApp", icono: "chat" },
  correo: { texto: "Correo", icono: "mail" },
  esperar: { texto: "Esperar", icono: "hourglass_empty" },
};

export const CONDICIONES: Record<Paso["condicion"], string> = {
  siempre: "Siempre",
  sin_respuesta: "Solo si no ha respondido",
  no_conecto: "Solo si nunca contestó",
};

export const ESTADOS_SECUENCIA: Record<Secuencia["estado"], { texto: string; tono: TonoInsignia }> = {
  borrador: { texto: "Borrador", tono: "" },
  activa: { texto: "Activa", tono: "ok" },
  pausada: { texto: "Pausada", tono: "aviso" },
  completada: { texto: "Completada", tono: "info" },
  archivada: { texto: "Archivada", tono: "" },
};

export const ESTADOS_INSCRIPCION: Record<string, { texto: string; tono: TonoInsignia }> = {
  activa: { texto: "En curso", tono: "primaria" },
  esperando: { texto: "Esperando llamada", tono: "info" },
  completada: { texto: "Completada", tono: "ok" },
  respondio: { texto: "Respondió", tono: "ok" },
  agendo: { texto: "Agendó", tono: "ok" },
  detenida: { texto: "Detenida", tono: "" },
  fallida: { texto: "Fallida", tono: "error" },
  baja: { texto: "Se dio de baja", tono: "aviso" },
};

export function pasoVacio(tipo: TipoPaso = "llamada"): Paso {
  return {
    tipo, espera_min: 0, condicion: "siempre", agente_id: null, max_intentos: 3, intentos_por_dia: 1,
    reintento_min: 240, whatsapp_tras_intento: null, plantilla_fallback_id: null, plantilla_id: null,
    variables: [], texto: "", asunto: "", cuerpo: "",
  };
}

/** Convierte minutos a texto amigable: 90 → "1 h 30 min", 2880 → "2 días". */
export function textoEspera(min: number): string {
  if (!min) return "de inmediato";
  if (min % 1440 === 0) return `${min / 1440} ${min === 1440 ? "día" : "días"}`;
  if (min >= 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${min} min`;
}

export function ResumenPasos({ pasos }: { pasos: Paso[] }) {
  if (!pasos.length) return <span className="tenue chico">Sin pasos</span>;
  return (
    <span className="fila" style={{ gap: "var(--gap-4)" }}>
      {pasos.map((p, i) => (
        <span key={i} className="fila" style={{ gap: "var(--gap-4)" }}>
          {i > 0 && <Icono n="chevron_right" className="tenue" />}
          <span className="insignia" title={`${TIPOS_PASO[p.tipo].texto} · ${CONDICIONES[p.condicion]}`}>
            <Icono n={TIPOS_PASO[p.tipo].icono} />
            {p.tipo === "llamada" ? `×${p.max_intentos}` : TIPOS_PASO[p.tipo].texto}
          </span>
        </span>
      ))}
    </span>
  );
}
