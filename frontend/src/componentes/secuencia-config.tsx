// Configuración de ejecución de una campaña: horario, A/B, caller ID, línea y ritmo.
import type { Agente, Linea, Numero, Secuencia } from "../tipos";
import { Banner, Boton, Campo, Check, Icono, Tarjeta } from "./ui";

const DIAS: { id: string; texto: string }[] = [
  { id: "lun", texto: "Lunes" }, { id: "mar", texto: "Martes" }, { id: "mie", texto: "Miércoles" },
  { id: "jue", texto: "Jueves" }, { id: "vie", texto: "Viernes" }, { id: "sab", texto: "Sábado" }, { id: "dom", texto: "Domingo" },
];
const ZONAS = ["America/Bogota", "America/Mexico_City", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires",
  "America/Guayaquil", "America/Caracas", "America/Panama", "America/Costa_Rica", "America/Guatemala", "America/Montevideo",
  "America/Santo_Domingo", "America/New_York", "America/Los_Angeles", "Europe/Madrid", "UTC"];

type Horario = Secuencia["horario"];
const laborales = (franjas: [string, string][]): Horario => Object.fromEntries(["lun", "mar", "mie", "jue", "vie"].map((d) => [d, franjas.map((f) => [...f] as [string, string])]));
const PRESETS: { texto: string; horario: () => Horario }[] = [
  { texto: "Oficina (L–V 9–12:30 y 14–18)", horario: () => laborales([["09:00", "12:30"], ["14:00", "18:00"]]) },
  { texto: "L–V 8–19", horario: () => laborales([["08:00", "19:00"]]) },
  { texto: "L–S 9–18", horario: () => ({ ...laborales([["09:00", "18:00"]]), sab: [["09:00", "13:00"]] }) },
  { texto: "Siempre", horario: () => Object.fromEntries(DIAS.map((d) => [d.id, [["00:00", "23:59"]]])) },
];

/** ISO UTC → valor de <input type="datetime-local"> en hora local del navegador. */
function aLocal(iso: string): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export type BorradorSecuencia = Omit<Secuencia, "id" | "estado" | "conteos" | "creado">;

export default function ConfigSecuencia({ s, onCambio, agentes, numeros, lineas, soloLectura }: {
  s: BorradorSecuencia; onCambio: (s: BorradorSecuencia) => void; agentes: Agente[]; numeros: Numero[]; lineas: Linea[]; soloLectura: boolean;
}) {
  const set = <K extends keyof BorradorSecuencia>(k: K, v: BorradorSecuencia[K]) => onCambio({ ...s, [k]: v });
  const setDia = (dia: string, franjas: [string, string][]) => {
    const h = { ...s.horario };
    if (franjas.length) h[dia] = franjas; else delete h[dia];
    set("horario", h);
  };
  const pesos = Object.entries(s.ab_agentes);
  const sumaPesos = pesos.reduce((a, [, p]) => a + Number(p), 0);
  const usaLlamadas = s.pasos.some((p) => p.tipo === "llamada");
  const usaWhatsapp = s.pasos.some((p) => p.tipo === "whatsapp");

  return (
    <fieldset disabled={soloLectura} style={{ border: "none", padding: 0, margin: 0 }} className="pila">
      <Tarjeta titulo="Horario de contacto" icono="schedule">
        <div className="pila">
          <div className="rejilla c2">
            <Campo etiqueta="Zona horaria de la campaña">
              <select value={s.zona_horaria} onChange={(e) => set("zona_horaria", e.target.value)}>
                {[...new Set([s.zona_horaria, ...ZONAS])].map((z) => <option key={z}>{z}</option>)}
              </select>
            </Campo>
            <Campo etiqueta=" " ayuda="Un contacto de México se llama en su horario local, no en el de Bogotá.">
              <Check valor={s.usar_zona_contacto} onCambio={(v) => set("usar_zona_contacto", v)}>Usar la zona horaria de cada contacto</Check>
            </Campo>
          </div>
          <div className="fila">
            <span className="chico tenue">Atajos:</span>
            {PRESETS.map((p) => <Boton key={p.texto} chico variante="contorno" onClick={() => set("horario", p.horario())}>{p.texto}</Boton>)}
          </div>
          <div className="pila c">
            {DIAS.map((d) => {
              const franjas = s.horario[d.id] ?? [];
              return (
                <div key={d.id} className="fila" style={{ alignItems: "flex-start" }}>
                  <div style={{ width: 110, paddingTop: 8 }}>
                    <Check valor={franjas.length > 0} onCambio={(v) => setDia(d.id, v ? [["09:00", "18:00"]] : [])}>{d.texto}</Check>
                  </div>
                  <div className="fila crece">
                    {franjas.length === 0 && <span className="tenue chico" style={{ paddingTop: 8 }}>No se contacta</span>}
                    {franjas.map((f, i) => (
                      <span key={i} className="fila" style={{ gap: "var(--gap-4)", flexWrap: "nowrap" }}>
                        <input type="time" value={f[0]} style={{ width: 110 }} onChange={(e) => setDia(d.id, franjas.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                        <span className="tenue">–</span>
                        <input type="time" value={f[1]} style={{ width: 110 }} onChange={(e) => setDia(d.id, franjas.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                        <Boton chico icono="close" variante="texto" aria-label="Quitar franja" onClick={() => setDia(d.id, franjas.filter((_, j) => j !== i))} />
                      </span>
                    ))}
                    {franjas.length > 0 && (
                      <Boton chico icono="add" variante="texto" onClick={() => setDia(d.id, [...franjas, ["14:00", "18:00"]])}>Franja</Boton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="tenue chico" style={{ margin: 0 }}>Fuera de franja el paso se reprograma al inicio de la siguiente sin contar como intento.</p>
        </div>
      </Tarjeta>

      <Tarjeta titulo="Agentes (A/B)" icono="science">
        <div className="pila">
          <p className="tenue chico" style={{ margin: 0 }}>Cada contacto se asigna a un agente según su peso (hasta 4, suman 100%). Compara resultados en la pestaña Resultados.</p>
          {pesos.map(([id, peso]) => (
            <div key={id} className="fila">
              <select className="crece" value={id} onChange={(e) => {
                const n = { ...s.ab_agentes };
                delete n[id];
                n[e.target.value] = peso;
                set("ab_agentes", n);
              }}>
                {agentes.filter((a) => a.id === Number(id) || !(String(a.id) in s.ab_agentes)).map((a) => (
                  <option key={a.id} value={a.id}>{a.nombre}{a.publicado ? "" : " (sin publicar)"}</option>
                ))}
              </select>
              <input type="number" min={0} max={100} value={peso} style={{ width: 90 }}
                onChange={(e) => set("ab_agentes", { ...s.ab_agentes, [id]: Number(e.target.value) })} />
              <span className="tenue">%</span>
              <Boton chico icono="close" variante="texto" aria-label="Quitar agente" onClick={() => {
                const n = { ...s.ab_agentes };
                delete n[id];
                set("ab_agentes", n);
              }} />
            </div>
          ))}
          <div className="fila e">
            <Boton chico variante="contorno" icono="add" disabled={pesos.length >= 4 || pesos.length >= agentes.length}
              onClick={() => {
                const libre = agentes.find((a) => !(String(a.id) in s.ab_agentes));
                if (!libre) return;
                const nuevos = { ...s.ab_agentes, [libre.id]: 0 };
                const n = Object.keys(nuevos).length;
                const base = Math.floor(100 / n);
                set("ab_agentes", Object.fromEntries(Object.keys(nuevos).map((k, i) => [k, i === 0 ? 100 - base * (n - 1) : base])));
              }}>Agregar agente</Boton>
            {pesos.length > 0 && (
              <span className={sumaPesos === 100 ? "tenue chico" : "chico"} style={sumaPesos === 100 ? {} : { color: "var(--error)" }}>
                Suma: {sumaPesos}% {sumaPesos !== 100 && "(debe ser 100%)"}
              </span>
            )}
          </div>
          {!pesos.length && <Banner tono="aviso" icono="warning">Sin agente asignado, los pasos de llamada necesitan elegir uno explícitamente.</Banner>}
        </div>
      </Tarjeta>

      {usaLlamadas && (
        <Tarjeta titulo="Números de salida (rotación de caller ID)" icono="dialpad">
          <div className="pila c">
            {!numeros.length && <Banner tono="aviso" icono="warning">No hay números. Agrégalos en Canales → Telefonía.</Banner>}
            {numeros.map((n) => (
              <label key={n.id} className="fila e tarjeta plana" style={{ padding: "var(--padding-8) var(--padding-12)", cursor: "pointer" }}>
                <span className="fila">
                  <input type="checkbox" checked={s.numeros_ids.includes(n.id)}
                    onChange={(e) => set("numeros_ids", e.target.checked ? [...s.numeros_ids, n.id] : s.numeros_ids.filter((x) => x !== n.id))} />
                  <span className="mono">{n.numero}</span>
                  {n.etiqueta && <span className="tenue">{n.etiqueta}</span>}
                  {!n.activo && <span className="insignia">inactivo</span>}
                </span>
                <span className="chico tenue ds-numeric">{n.usados_24h ?? 0} / {n.tope_diario} en 24 h</span>
              </label>
            ))}
            <p className="tenue chico" style={{ margin: 0 }}>Se elige el número menos usado del mismo país del contacto, respetando el tope diario de cada uno para no quemarlo como spam.</p>
          </div>
        </Tarjeta>
      )}

      {usaWhatsapp && (
        <Tarjeta titulo="Línea de WhatsApp" icono="chat">
          <Campo ayuda="Para pasos con texto libre. Las plantillas usan la línea donde fueron aprobadas.">
            <select value={s.linea_id ?? ""} onChange={(e) => set("linea_id", e.target.value ? Number(e.target.value) : null)}>
              <option value="">Sin línea</option>
              {lineas.map((l) => <option key={l.id} value={l.id}>{l.numero_visible || l.phone_number_id} · calidad {l.calidad}</option>)}
            </select>
          </Campo>
        </Tarjeta>
      )}

      <Tarjeta titulo="Ritmo y reglas de parada" icono="tune">
        <div className="pila">
          <div className="rejilla c3">
            <Campo etiqueta="Tamaño de lote" ayuda="Contactos procesados por ciclo (1–500)">
              <input type="number" min={1} max={500} value={s.tamano_lote} onChange={(e) => set("tamano_lote", Number(e.target.value))} />
            </Campo>
            <Campo etiqueta="Segundos entre llamadas" ayuda="Ritmo de marcado de esta campaña">
              <input type="number" min={1} max={600} value={s.segundos_entre_llamadas} onChange={(e) => set("segundos_entre_llamadas", Number(e.target.value))} />
            </Campo>
            <Campo etiqueta="Fecha de fin (opcional)">
              <input type="datetime-local" value={s.fecha_fin ? aLocal(s.fecha_fin) : ""}
                onChange={(e) => set("fecha_fin", e.target.value ? new Date(e.target.value).toISOString() : null)} />
            </Campo>
          </div>
          <Check valor={s.detener_al_responder} onCambio={(v) => set("detener_al_responder", v)}>Detener la campaña para un contacto cuando responda</Check>
          <Check valor={s.detener_al_agendar} onCambio={(v) => set("detener_al_agendar", v)}>Detener cuando agende una cita</Check>
          <p className="tenue chico fila" style={{ margin: 0 }}><Icono n="shield" /> Siempre activos: cooldown global de 1 h entre llamadas a un contacto, dedupe de 24 h en WhatsApp, opt-out y concurrencia del plan.</p>
        </div>
      </Tarjeta>
    </fieldset>
  );
}
