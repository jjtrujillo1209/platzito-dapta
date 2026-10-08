// Panel: KPIs, serie diaria, motivos de corte, canales, agentes y salud de líneas.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api";
import { BarrasH, completarDias, GraficaLineas } from "../componentes/panel-graficas";
import { Banner, Boton, CANALES, Cargando, Encabezado, Icono, Insignia, Kpi, Tarjeta, useCarga, fmt } from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Agente, Cerebro, Linea, Metricas, Numero, Secuencia } from "../tipos";

const RANGOS = [7, 30, 90];
const RAZONES: Record<string, string> = {
  user_hangup: "Colgó el contacto", agent_hangup: "Colgó el agente", call_transfer: "Transferida",
  voicemail_reached: "Buzón de voz", inactivity: "Inactividad", max_duration_reached: "Duración máxima",
  dial_no_answer: "No contestó", dial_busy: "Ocupado", dial_failed: "Falló el marcado", error_llm_websocket_open: "Error del cerebro",
  webhook_perdido: "Sin confirmación", concurrency_limit_reached: "Límite de concurrencia", invalid_destination: "Número inválido",
  user_declined: "Rechazada", marked_as_spam: "Marcada como spam",
};
const CALIDAD: Record<string, { texto: string; tono: "ok" | "aviso" | "error" | "" }> = {
  GREEN: { texto: "Alta", tono: "ok" }, YELLOW: { texto: "Media", tono: "aviso" }, RED: { texto: "Baja", tono: "error" }, UNKNOWN: { texto: "Sin dato", tono: "" },
};

function Onboarding() {
  const { puede } = useSesion();
  const integraciones = useCarga(() => (puede("admin")
    ? api.get<{ tipo: string; configurada: boolean }[]>("/api/integraciones")
    : Promise.resolve([] as { tipo: string; configurada: boolean }[])), [puede("admin")]);
  const agentes = useCarga(() => api.get<Agente[]>("/api/agentes"));
  const cerebros = useCarga(() => api.get<Cerebro[]>("/api/cerebros"));
  const lineas = useCarga(() => api.get<Linea[]>("/api/lineas"));
  const numeros = useCarga(() => api.get<Numero[]>("/api/numeros"));
  const secuencias = useCarga(() => api.get<Secuencia[]>("/api/secuencias"));
  const llm = integraciones.datos?.some((i) => ["anthropic", "openai", "groq", "gemini", "ollama"].includes(i.tipo) && i.configurada);
  const pasos = [
    { hecho: !!llm, texto: "Conecta un modelo de IA (Anthropic, OpenAI, Ollama…)", a: "/ajustes", icono: "key" },
    { hecho: !!cerebros.datos?.some((c) => (c.n_fragmentos ?? 0) > 0), texto: "Carga tu base de conocimiento (web, PDFs, textos)", a: "/conocimiento", icono: "psychology" },
    { hecho: !!agentes.datos?.some((a) => a.publicado), texto: "Crea, prueba y publica tu primer agente", a: "/agentes", icono: "smart_toy" },
    { hecho: !!(lineas.datos?.length || numeros.datos?.length), texto: "Conecta WhatsApp o un número de voz", a: "/canales", icono: "hub" },
    { hecho: !!secuencias.datos?.some((s) => s.estado === "activa"), texto: "Lanza una campaña outbound", a: "/secuencias", icono: "campaign" },
  ];
  const hechos = pasos.filter((p) => p.hecho).length;
  if (hechos === pasos.length) return null;
  return (
    <Tarjeta titulo={`Pon en marcha Platzito · ${hechos}/${pasos.length}`} icono="rocket_launch">
      <div className="pila c">
        <div className="barra-h"><span style={{ width: `${(hechos / pasos.length) * 100}%` }} /></div>
        {pasos.map((p) => (
          <Link key={p.texto} to={p.a} className="fila e tarjeta plana" style={{ padding: "var(--padding-12) var(--padding-16)", color: "inherit" }}>
            <span className="fila">
              <Icono n={p.hecho ? "check_circle" : p.icono} fill={p.hecho} className={p.hecho ? "" : "tenue"} />
              <span style={{ textDecoration: p.hecho ? "line-through" : undefined, opacity: p.hecho ? 0.6 : 1 }}>{p.texto}</span>
            </span>
            {!p.hecho && <Icono n="chevron_right" className="tenue" />}
          </Link>
        ))}
      </div>
    </Tarjeta>
  );
}

export default function Panel() {
  const { espacio } = useSesion();
  const [dias, setDias] = useState(30);
  const [agenteId, setAgenteId] = useState("");
  const { hasta, desde } = useMemo(() => {
    const h = new Date();
    const d = new Date(h.getTime() - (dias - 1) * 86400000);
    d.setHours(0, 0, 0, 0);
    return { hasta: h, desde: d };
  }, [dias]);
  const agentes = useCarga(() => api.get<Agente[]>("/api/agentes")).datos ?? [];
  const { datos: m, error, cargando } = useCarga(
    () => api.get<Metricas>(`/api/metricas${qs({ desde: desde.toISOString().slice(0, 19), agente_id: agenteId })}`),
    [desde, agenteId]);

  const serie = useMemo(() => (m ? completarDias(m.serie, desde, hasta, (dia) => ({ dia, conversaciones: 0, llamadas: 0, contestadas: 0 })) : []), [m, desde, hasta]);
  const vacio = m && m.conversaciones.total === 0 && m.llamadas.total === 0;

  return (
    <div className="pagina">
      <Encabezado
        titulo={`Hola${espacio ? `, ${espacio.nombre}` : ""}`}
        descripcion="Lo que pasó en tus canales y campañas."
        acciones={<>
          <select value={agenteId} onChange={(e) => setAgenteId(e.target.value)} style={{ width: 200 }} aria-label="Agente">
            <option value="">Todos los agentes</option>
            {agentes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
          <div className="fila" style={{ gap: 4 }} role="group" aria-label="Rango">
            {RANGOS.map((r) => <Boton key={r} chico variante={dias === r ? "secundario" : "contorno"} onClick={() => setDias(r)}>{r} días</Boton>)}
          </div>
        </>}
      />
      {error && <Banner tono="error" icono="error">{error}</Banner>}
      {cargando && !m ? <Cargando /> : m && (
        <div className="pila">
          {vacio && <Onboarding />}
          <div className="rejilla c4">
            <Kpi etiqueta="Conversaciones" valor={fmt.numero(m.conversaciones.total)} nota={`${fmt.numero(m.conversaciones.contactos_unicos)} contactos · ${fmt.numero(m.conversaciones.mensajes_ia)} respuestas IA`} />
            <Kpi etiqueta="Tasa de éxito" valor={m.conversaciones.analizadas ? fmt.pct(m.conversaciones.tasa_exito) : "—"} nota={`${fmt.numero(m.conversaciones.exitosas)} de ${fmt.numero(m.conversaciones.analizadas)} analizadas`} />
            <Kpi etiqueta="Escaladas a humano" valor={fmt.numero(m.conversaciones.escaladas)} nota={m.conversaciones.total ? `${fmt.pct(m.conversaciones.escaladas / m.conversaciones.total)} del total` : undefined} />
            <Kpi etiqueta="Citas agendadas" valor={fmt.numero(m.citas)} />
            <Kpi etiqueta="Llamadas" valor={fmt.numero(m.llamadas.total)} nota={`${fmt.numero(m.llamadas.minutos_totales)} min · ${fmt.numero(m.llamadas.contactos_unicos)} contactos`} />
            <Kpi etiqueta="Tasa de conexión" valor={m.llamadas.total ? fmt.pct(m.llamadas.tasa_conexion) : "—"} nota={`${fmt.numero(m.llamadas.contestadas)} contestadas`} />
            <Kpi etiqueta="Duración promedio" valor={m.llamadas.contestadas ? fmt.duracion(m.llamadas.duracion_promedio_s) : "—"} nota={m.llamadas.latencia_promedio_ms ? `Latencia del cerebro ${fmt.numero(m.llamadas.latencia_promedio_ms)} ms` : "de las contestadas"} />
            <Kpi etiqueta="Costo total" valor={fmt.usd(m.costo_usd)} nota="IA + telefonía, estimado" />
          </div>

          <Tarjeta titulo="Actividad diaria" icono="show_chart">
            <GraficaLineas filas={serie} series={[
              { clave: "conversaciones", texto: "Conversaciones", color: "var(--primary)" },
              { clave: "llamadas", texto: "Llamadas", color: "var(--tertiary-fixed-dim)" },
              { clave: "contestadas", texto: "Contestadas", color: "var(--tertiary-fixed-dim)", discontinua: true },
            ]} />
          </Tarjeta>

          <div className="rejilla c2">
            <Tarjeta titulo="Por qué terminan las llamadas" icono="call_end">
              <BarrasH vacio="Sin llamadas en el rango" filas={Object.entries(m.llamadas.por_razon).sort((a, b) => b[1] - a[1]).slice(0, 8)
                .map(([k, v]) => ({ etiqueta: RAZONES[k] ?? k, valor: v }))} />
            </Tarjeta>
            <Tarjeta titulo="Conversaciones por canal" icono="forum">
              <BarrasH vacio="Sin conversaciones en el rango" filas={Object.entries(m.conversaciones.por_canal).sort((a, b) => b[1] - a[1])
                .map(([k, v]) => ({ etiqueta: CANALES[k]?.texto ?? k, valor: v }))} />
            </Tarjeta>
          </div>

          <div className="rejilla c2">
            <Tarjeta titulo="Agentes" icono="smart_toy">
              {m.por_agente.length ? (
                <div className="tabla-env">
                  <table className="tabla">
                    <thead><tr><th>Agente</th><th className="num">Conversaciones</th><th className="num">Éxito</th><th className="num">Costo</th></tr></thead>
                    <tbody>
                      {[...m.por_agente].sort((a, b) => b.conversaciones - a.conversaciones).map((a) => (
                        <tr key={String(a.agente_id)}>
                          <td>{a.agente_id ? <Link to={`/agentes/${a.agente_id}`}>{a.nombre}</Link> : <span className="tenue">Sin agente</span>}</td>
                          <td className="num">{fmt.numero(a.conversaciones)}</td>
                          <td className="num">{a.conversaciones ? fmt.pct(a.exitosas / a.conversaciones) : "—"}</td>
                          <td className="num">{fmt.usd(a.costo_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="tenue">Sin actividad en el rango.</p>}
            </Tarjeta>
            <Tarjeta titulo="Salud de las líneas de WhatsApp" icono="health_and_safety">
              {m.lineas.length ? (
                <div className="pila c">
                  {m.lineas.map((l) => {
                    const c = CALIDAD[l.calidad] ?? CALIDAD.UNKNOWN;
                    return (
                      <div key={l.id} className="fila e tarjeta plana" style={{ padding: "var(--padding-12) var(--padding-16)" }}>
                        <span className="mono">{l.numero || `Línea ${l.id}`}</span>
                        <span className="fila" style={{ gap: 6 }}>
                          <Insignia tono={c.tono}><Icono n={c.tono === "ok" ? "check_circle" : c.tono === "error" ? "error" : "warning"} />Calidad {c.texto}</Insignia>
                          <Insignia>{l.tier.replace("TIER_", "Tier ")}</Insignia>
                          {l.marketing_pausado && <Insignia tono="aviso"><Icono n="pause_circle" />Marketing en pausa</Insignia>}
                        </span>
                      </div>
                    );
                  })}
                  <Link to="/canales" className="chico">Ver detalle de líneas →</Link>
                </div>
              ) : <p className="tenue">No hay líneas conectadas. <Link to="/canales">Conectar WhatsApp</Link></p>}
            </Tarjeta>
          </div>
        </div>
      )}
    </div>
  );
}
