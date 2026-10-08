// Registro de llamadas: filtros, KPIs del rango, exportación CSV y detalle con grabación y transcript.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api";
import Hilo from "../componentes/inbox-hilo";
import {
  Banner, Boton, Cajon, Campo, Cargando, Encabezado, Icono, Insignia, Kpi, RESULTADOS_LLAMADA, Vacio, fmt, useAvisos,
  useCarga, useIntervalo,
} from "../componentes/ui";
import type { Agente, Conversacion, Llamada, Mensaje, Metricas } from "../tipos";
import "./inbox-estilos.css";

const RAZONES: Record<string, string> = {
  user_hangup: "Colgó el contacto", agent_hangup: "Colgó el agente", call_transfer: "Transferida",
  voicemail_reached: "Buzón de voz", inactivity: "Inactividad", max_duration_reached: "Duración máxima",
  dial_no_answer: "No contestó", dial_busy: "Ocupado", dial_failed: "Marcación fallida", webhook_perdido: "Sin respuesta de Retell",
};

function hoyMenos(dias: number) {
  const d = new Date(Date.now() - dias * 86400000);
  return d.toISOString().slice(0, 10);
}

function Detalle({ id, agentes, onCerrar }: { id: number; agentes: Agente[]; onCerrar: () => void }) {
  const { datos: l, error } = useCarga(
    () => api.get<Llamada & { conversacion: Conversacion | null; transcript: Mensaje[]; datos: Record<string, any> }>(`/api/llamadas/${id}`),
    [id],
  );
  const c = l?.conversacion;
  return (
    <Cajon titulo={`Llamada #${id}`} onCerrar={onCerrar}>
      {error && <Banner tono="error">{error}</Banner>}
      {!l ? <Cargando /> : (
        <>
          <div className="fila">
            <Insignia tono={RESULTADOS_LLAMADA[l.resultado]?.tono}>{RESULTADOS_LLAMADA[l.resultado]?.texto ?? l.resultado}</Insignia>
            <Insignia>{l.tipo === "web" ? "Web" : l.direccion}</Insignia>
            {l.intento > 1 && <Insignia>Intento {l.intento}</Insignia>}
            {c?.exito !== null && c?.exito !== undefined && <Insignia tono={c.exito ? "ok" : "error"}>{c.exito ? "Objetivo logrado" : "Sin éxito"}</Insignia>}
          </div>
          <div className="rejilla c2">
            <div className="pila c">
              <span className="chico tenue">Contacto</span>
              {c?.contacto ? <Link to={`/contactos/${c.contacto.id}`}>{c.contacto.nombre || c.contacto.telefono}</Link> : <span>{l.hacia || l.desde || "—"}</span>}
              <span className="chico tenue">Desde → hacia</span>
              <span className="mono">{l.desde || "—"} → {l.hacia || "—"}</span>
              <span className="chico tenue">Agente</span>
              <span>{agentes.find((a) => a.id === l.agente_id)?.nombre ?? "—"}</span>
            </div>
            <div className="pila c">
              <span className="chico tenue">Fecha</span><span>{fmt.fecha(l.inicio ?? l.creado)}</span>
              <span className="chico tenue">Duración · motivo</span>
              <span>{fmt.duracion(l.duracion_s)} · {RAZONES[l.razon_desconexion] ?? (l.razon_desconexion || "—")}</span>
              <span className="chico tenue">Latencia LLM (mediana) · costo</span>
              <span>{l.latencia_ms ? `${l.latencia_ms} ms` : "—"} · {fmt.usd(l.costo_usd + (c?.costo_usd ?? 0))}</span>
            </div>
          </div>
          {l.grabacion_url && <audio controls preload="none" src={l.grabacion_url} style={{ width: "100%" }} />}
          {c && (c.resumen || Object.keys(c.analisis ?? {}).length > 0) && (
            <div className="tarjeta pila c">
              <b><Icono n="insights" /> Análisis</b>
              {c.resumen && <p style={{ margin: 0 }}>{c.resumen}</p>}
              {c.sentimiento && <div className="inbox-dato"><span>Sentimiento</span><span>{c.sentimiento}</span></div>}
              {Object.entries(c.analisis ?? {}).map(([k, v]) => <div key={k} className="inbox-dato"><span>{k}</span><span>{String(v)}</span></div>)}
            </div>
          )}
          <div className="fila e">
            <b>Transcript</b>
            {c && <Link to={`/inbox/${c.id}`} className="chico">Abrir en Inbox</Link>}
          </div>
          {l.transcript.length ? <Hilo mensajes={l.transcript} /> : <span className="tenue chico">Sin transcript (la llamada no conectó o aún no termina).</span>}
        </>
      )}
    </Cajon>
  );
}

export default function Llamadas() {
  const avisar = useAvisos();
  const [desde, setDesde] = useState(hoyMenos(7));
  const [hasta, setHasta] = useState(hoyMenos(0));
  const [agente, setAgente] = useState("");
  const [resultados, setResultados] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [pagina, setPagina] = useState(1);
  const [abierta, setAbierta] = useState<number | null>(null);
  const filtros = { desde, hasta: hasta ? `${hasta}T23:59:59` : "", agente_id: agente, resultado: resultados.join(",") };
  const clave = JSON.stringify(filtros);
  const { datos: agentes } = useCarga(() => api.get<Agente[]>("/api/agentes"), []);
  const { datos, error, recargar } = useCarga(
    () => api.get<{ total: number; llamadas: Llamada[] }>(`/api/llamadas${qs({ ...filtros, q, pagina })}`),
    [clave, q, pagina],
  );
  const { datos: m } = useCarga(() => api.get<Metricas>(`/api/metricas${qs({ desde: filtros.desde, hasta: filtros.hasta, agente_id: agente })}`), [clave]);
  useIntervalo(recargar, 10000);
  const paginas = datos ? Math.max(1, Math.ceil(datos.total / 50)) : 1;
  const exportar = async () => {
    try {
      await api.descargar(`/api/llamadas/exportar${qs(filtros)}`, `llamadas-${desde}-a-${hasta}.csv`);
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const alternar = (r: string) => { setPagina(1); setResultados((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r])); };
  const ll = m?.llamadas;
  const razones = Object.entries(ll?.por_razon ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxRazon = Math.max(1, ...razones.map(([, n]) => n));

  return (
    <div className="pagina">
      <Encabezado titulo="Llamadas" descripcion="Registro de todas las llamadas de voz: salientes, entrantes y de prueba web."
        acciones={<Boton variante="contorno" icono="download" onClick={exportar}>Exportar CSV</Boton>} />
      <div className="fila" style={{ marginBottom: "var(--gap-16)", alignItems: "flex-end" }}>
        <Campo etiqueta="Desde"><input type="date" value={desde} onChange={(e) => { setDesde(e.target.value); setPagina(1); }} /></Campo>
        <Campo etiqueta="Hasta"><input type="date" value={hasta} onChange={(e) => { setHasta(e.target.value); setPagina(1); }} /></Campo>
        <Campo etiqueta="Agente">
          <select value={agente} onChange={(e) => { setAgente(e.target.value); setPagina(1); }}>
            <option value="">Todos</option>
            {agentes?.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Teléfono"><input type="search" value={q} placeholder="+57…" onChange={(e) => { setQ(e.target.value); setPagina(1); }} /></Campo>
      </div>
      <div className="fila" style={{ marginBottom: "var(--gap-16)", gap: 6 }}>
        {(["contestada", "no_contesta", "ocupado", "buzon", "fallida"] as const).map((r) => (
          <Boton key={r} chico variante={resultados.includes(r) ? "secundario" : "contorno"} onClick={() => alternar(r)}>
            {RESULTADOS_LLAMADA[r].texto}{ll?.por_resultado?.[r] ? ` · ${ll.por_resultado[r]}` : ""}
          </Boton>
        ))}
      </div>
      {ll && (
        <div className="rejilla c4" style={{ marginBottom: "var(--gap-16)" }}>
          <Kpi etiqueta="Llamadas" valor={fmt.numero(ll.total)} nota={`${fmt.numero(ll.contactos_unicos)} contactos únicos`} />
          <Kpi etiqueta="Tasa de conexión" valor={fmt.pct(ll.tasa_conexion)} nota={`${fmt.numero(ll.contestadas)} contestadas`} />
          <Kpi etiqueta="Duración promedio" valor={fmt.duracion(ll.duracion_promedio_s)} nota={`${fmt.numero(ll.minutos_totales)} min en total`} />
          <Kpi etiqueta="Latencia IA" valor={ll.latencia_promedio_ms ? `${ll.latencia_promedio_ms} ms` : "—"} nota="mediana por llamada, promediada" />
        </div>
      )}
      {razones.length > 0 && (
        <div className="tarjeta" style={{ marginBottom: "var(--gap-16)" }}>
          <h3>Motivos de fin</h3>
          <div className="pila c">
            {razones.map(([r, n]) => (
              <div key={r} className="fila" style={{ flexWrap: "nowrap" }}>
                <span style={{ width: 200 }} className="chico trunc">{RAZONES[r] ?? r}</span>
                <div className="barra-h crece"><span style={{ width: `${(n / maxRazon) * 100}%` }} /></div>
                <span className="chico num" style={{ width: 48 }}>{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <Banner tono="error">{error}</Banner>}
      {!datos && !error && <Cargando />}
      {datos && datos.llamadas.length === 0 && (
        <Vacio icono="call" titulo="Sin llamadas en este rango">
          Prueba un agente de voz desde su editor (llamada web) o lanza una campaña con un paso de llamada.
        </Vacio>
      )}
      {datos && datos.llamadas.length > 0 && (
        <>
          <div className="tabla-env">
            <table className="tabla">
              <thead>
                <tr><th>Fecha</th><th>Contacto</th><th>Número</th><th>Agente</th><th>Resultado</th><th className="num">Duración</th><th>Resumen</th></tr>
              </thead>
              <tbody>
                {datos.llamadas.map((l) => (
                  <tr key={l.id} className="clic" onClick={() => setAbierta(l.id)}>
                    <td className="tenue" style={{ whiteSpace: "nowrap" }}>{fmt.fecha(l.creado)}</td>
                    <td>{l.contacto?.nombre || "—"}</td>
                    <td className="mono">
                      <Icono n={l.tipo === "web" ? "language" : l.direccion === "saliente" ? "call_made" : "call_received"} /> {l.direccion === "saliente" ? l.hacia : l.desde || l.hacia}
                    </td>
                    <td>{agentes?.find((a) => a.id === l.agente_id)?.nombre ?? "—"}</td>
                    <td>
                      <Insignia tono={RESULTADOS_LLAMADA[l.resultado]?.tono}>{RESULTADOS_LLAMADA[l.resultado]?.texto ?? l.resultado}</Insignia>
                      {l.exito && <> <Icono n="verified" titulo="Objetivo logrado" /></>}
                    </td>
                    <td className="num">{fmt.duracion(l.duracion_s)}</td>
                    <td className="trunc tenue" style={{ maxWidth: 320 }}>{l.resumen || RAZONES[l.razon_desconexion] || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {paginas > 1 && (
            <div className="fila e" style={{ marginTop: "var(--gap-12)" }}>
              <span className="tenue chico">{fmt.numero(datos.total)} llamadas · página {pagina} de {paginas}</span>
              <div className="acciones">
                <Boton chico icono="chevron_left" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>Anterior</Boton>
                <Boton chico disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)}>Siguiente</Boton>
              </div>
            </div>
          )}
        </>
      )}
      {abierta && <Detalle id={abierta} agentes={agentes ?? []} onCerrar={() => setAbierta(null)} />}
    </div>
  );
}
