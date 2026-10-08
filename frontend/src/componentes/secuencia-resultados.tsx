// Resultados de una campaña: embudo, estados, resultados de llamada y A/B.
import { api } from "../api";
import type { Agente } from "../tipos";
import { ESTADOS_INSCRIPCION } from "./secuencia-comun";
import { Cargando, Insignia, Kpi, RESULTADOS_LLAMADA, Tarjeta, useCarga, Vacio, fmt } from "./ui";

interface MetricasSecuencia {
  inscritos: number;
  por_estado: Record<string, number>;
  llamadas: Record<string, number>;
  total_llamadas: number;
  contactos_llamados: number;
  tasa_conexion: number;
  contactos_conectados: number;
  respondieron: number;
  agendaron: number;
  por_paso: Record<string, number>;
  ab: { agente_id: number | null; inscritos: number; conectaron: number; agendaron: number }[];
}

function Barras({ filas }: { filas: { etiqueta: string; valor: number; nota?: string }[] }) {
  const max = Math.max(1, ...filas.map((f) => f.valor));
  return (
    <div className="pila c">
      {filas.map((f) => (
        <div key={f.etiqueta} className="pila" style={{ gap: 4 }}>
          <div className="fila e chico">
            <span>{f.etiqueta}</span>
            <span className="ds-numeric">{fmt.numero(f.valor)}{f.nota && <span className="tenue"> · {f.nota}</span>}</span>
          </div>
          <div className="barra-h" role="img" aria-label={`${f.etiqueta}: ${f.valor}`}>
            <span style={{ width: `${(f.valor / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ResultadosSecuencia({ id, agentes }: { id: number; agentes: Agente[] }) {
  const { datos: m, cargando } = useCarga(() => api.get<MetricasSecuencia>(`/api/secuencias/${id}/metricas`), [id]);
  if (cargando && !m) return <Cargando />;
  if (!m || !m.inscritos) return <div className="tarjeta"><Vacio icono="insights" titulo="Sin resultados todavía">Inscribe contactos y activa la campaña.</Vacio></div>;
  const pct = (n: number) => (m.inscritos ? fmt.pct(n / m.inscritos) : "0%");
  const nombre = (aid: number | null) => agentes.find((a) => a.id === aid)?.nombre ?? "Sin agente";
  return (
    <div className="pila">
      <div className="rejilla c4">
        <Kpi etiqueta="Inscritos" valor={fmt.numero(m.inscritos)} />
        <Kpi etiqueta="Tasa de conexión" valor={fmt.pct(m.tasa_conexion)} nota={`${fmt.numero(m.total_llamadas)} llamadas`} />
        <Kpi etiqueta="Respondieron" valor={fmt.numero(m.respondieron)} nota={pct(m.respondieron)} />
        <Kpi etiqueta="Agendaron" valor={fmt.numero(m.agendaron)} nota={pct(m.agendaron)} />
      </div>
      <div className="rejilla c2">
        <Tarjeta titulo="Embudo" icono="filter_alt">
          <Barras filas={[
            { etiqueta: "Inscritos", valor: m.inscritos },
            { etiqueta: "Contactos llamados", valor: m.contactos_llamados, nota: `${fmt.numero(m.total_llamadas)} llamadas` },
            { etiqueta: "Contactos que contestaron", valor: m.contactos_conectados, nota: pct(m.contactos_conectados) },
            { etiqueta: "Respondieron", valor: m.respondieron, nota: pct(m.respondieron) },
            { etiqueta: "Agendaron", valor: m.agendaron, nota: pct(m.agendaron) },
          ]} />
        </Tarjeta>
        <Tarjeta titulo="Resultado de las llamadas" icono="call">
          {m.total_llamadas ? (
            <Barras filas={Object.entries(m.llamadas).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({
              etiqueta: RESULTADOS_LLAMADA[k === "pendiente" ? "" : k]?.texto ?? k, valor: v, nota: fmt.pct(v / m.total_llamadas),
            }))} />
          ) : <p className="tenue">Aún no hay llamadas.</p>}
        </Tarjeta>
        <Tarjeta titulo="Contactos por estado" icono="donut_small">
          <Barras filas={Object.entries(m.por_estado).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({
            etiqueta: ESTADOS_INSCRIPCION[k]?.texto ?? k, valor: v, nota: pct(v),
          }))} />
        </Tarjeta>
        <Tarjeta titulo="Contactos por paso actual" icono="format_list_numbered">
          <Barras filas={Object.entries(m.por_paso).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => ({ etiqueta: `Paso ${Number(k) + 1}`, valor: v }))} />
        </Tarjeta>
      </div>
      {m.ab.length > 0 && (
        <Tarjeta titulo="A/B de agentes" icono="science">
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Agente</th><th className="num">Inscritos</th><th className="num">Contestaron</th><th className="num">% conexión</th><th className="num">Agendaron</th><th className="num">% agendamiento</th></tr></thead>
              <tbody>
                {m.ab.map((f) => {
                  const mejor = m.ab.length > 1 && f.inscritos > 0 && f.agendaron / f.inscritos === Math.max(...m.ab.map((x) => (x.inscritos ? x.agendaron / x.inscritos : 0))) && f.agendaron > 0;
                  return (
                    <tr key={String(f.agente_id)}>
                      <td>{nombre(f.agente_id)} {mejor && <Insignia tono="ok">Mejor</Insignia>}</td>
                      <td className="num">{fmt.numero(f.inscritos)}</td>
                      <td className="num">{fmt.numero(f.conectaron)}</td>
                      <td className="num">{f.inscritos ? fmt.pct(f.conectaron / f.inscritos) : "—"}</td>
                      <td className="num">{fmt.numero(f.agendaron)}</td>
                      <td className="num">{f.inscritos ? fmt.pct(f.agendaron / f.inscritos) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Tarjeta>
      )}
    </div>
  );
}
