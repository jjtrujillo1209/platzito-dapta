// Gráficas del panel en SVG/HTML puro sobre tokens Sinapsis.
// Serie diaria: un solo eje (conteos), líneas de 2px, leyenda + rotulado directo, crosshair con tooltip.
import { useMemo, useRef, useState } from "react";

export interface SerieDef {
  clave: string;
  texto: string;
  color: string; // var(--token)
  discontinua?: boolean;
}

const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const fechaCorta = (d: string) => {
  const f = new Date(`${d}T12:00:00`);
  return `${f.getDate()}/${f.getMonth() + 1}`;
};

/** Completa los días sin datos con ceros para que el eje de tiempo sea continuo. */
export function completarDias<T extends { dia: string }>(filas: T[], desde: Date, hasta: Date, vacio: (dia: string) => T): T[] {
  const mapa = new Map(filas.map((f) => [f.dia, f]));
  const salida: T[] = [];
  const d = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  while (d <= hasta) {
    const clave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    salida.push(mapa.get(clave) ?? vacio(clave));
    d.setDate(d.getDate() + 1);
  }
  return salida;
}

function escalaBonita(max: number): number[] {
  if (max <= 0) return [0, 1];
  const paso0 = max / 4;
  const mag = 10 ** Math.floor(Math.log10(paso0));
  const paso = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= paso0) ?? paso0;
  const ticks = [];
  for (let v = 0; v <= max + paso * 0.001; v += paso) ticks.push(Math.round(v * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + paso);
  return ticks;
}

export function GraficaLineas({ filas, series, alto = 220 }: { filas: Record<string, number | string>[]; series: SerieDef[]; alto?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ancho = 720;
  const m = { izq: 40, der: 96, arr: 12, aba: 26 };
  const max = Math.max(0, ...filas.flatMap((f) => series.map((s) => Number(f[s.clave]) || 0)));
  const ticks = useMemo(() => escalaBonita(max), [max]);
  const tope = ticks[ticks.length - 1] || 1;
  const n = filas.length;
  const x = (i: number) => m.izq + (n <= 1 ? 0 : (i / (n - 1)) * (ancho - m.izq - m.der));
  const y = (v: number) => m.arr + (1 - v / tope) * (alto - m.arr - m.aba);
  const cadaN = Math.max(1, Math.ceil(n / 8));

  const mover = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * ancho;
    const i = Math.round(((px - m.izq) / (ancho - m.izq - m.der)) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  if (!n) return <p className="tenue">Sin datos en el rango.</p>;
  const ultimo = filas[n - 1];
  // Rótulos directos al final de cada línea, separados para no chocar
  const rotulos = series
    .map((s) => ({ s, y: y(Number(ultimo[s.clave]) || 0) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < rotulos.length; i++) rotulos[i].y = Math.max(rotulos[i].y, rotulos[i - 1].y + 14);

  const fila = hover !== null ? filas[hover] : null;
  return (
    <div className="pila c">
      <div className="fila" role="list" aria-label="Leyenda">
        {series.map((s) => (
          <span key={s.clave} role="listitem" className="fila chico" style={{ gap: 6 }}>
            <svg width="18" height="8" aria-hidden><line x1="1" y1="4" x2="17" y2="4" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={s.discontinua ? "4 3" : undefined} /></svg>
            <span className="tenue">{s.texto}</span>
          </span>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <svg ref={ref} viewBox={`0 0 ${ancho} ${alto}`} width="100%" role="img"
          aria-label={`Serie diaria: ${series.map((s) => s.texto).join(", ")}`}
          onMouseMove={mover} onMouseLeave={() => setHover(null)} style={{ display: "block", overflow: "visible" }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.izq} x2={ancho - m.der} y1={y(t)} y2={y(t)} stroke="var(--outline-variant)" strokeOpacity={t === 0 ? 1 : 0.4} strokeWidth="1" />
              <text x={m.izq - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--on-surface-variant)" style={{ fontVariantNumeric: "tabular-nums" }}>{t.toLocaleString("es-CO")}</text>
            </g>
          ))}
          {filas.map((f, i) => (i % cadaN === 0 || i === n - 1) && (
            <text key={i} x={x(i)} y={alto - 6} textAnchor="middle" fontSize="11" fill="var(--on-surface-variant)">{fechaCorta(String(f.dia))}</text>
          ))}
          {series.map((s) => (
            <polyline key={s.clave} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              strokeDasharray={s.discontinua ? "5 4" : undefined}
              points={filas.map((f, i) => `${x(i)},${y(Number(f[s.clave]) || 0)}`).join(" ")} />
          ))}
          {rotulos.map(({ s, y: yy }) => (
            <text key={s.clave} x={ancho - m.der + 8} y={yy + 4} fontSize="11" fill="var(--on-surface)">
              {s.texto} · {(Number(ultimo[s.clave]) || 0).toLocaleString("es-CO")}
            </text>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={m.arr} y2={alto - m.aba} stroke="var(--on-surface-variant)" strokeWidth="1" strokeDasharray="2 3" />
              {series.map((s) => (
                <circle key={s.clave} cx={x(hover)} cy={y(Number(filas[hover][s.clave]) || 0)} r="4.5" fill={s.color} stroke="var(--surf-cont-low)" strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>
        {fila && hover !== null && (
          <div className="tarjeta" style={{
            position: "absolute", top: 0, pointerEvents: "none", padding: "var(--padding-8) var(--padding-12)",
            left: `${(x(hover) / ancho) * 100}%`, transform: `translateX(${hover > n / 2 ? "calc(-100% - 12px)" : "12px"})`,
            background: "var(--surf-cont-highest)", minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,.3)",
          }}>
            <div className="chico" style={{ fontWeight: 600, marginBottom: 4 }}>
              {DIAS_CORTOS[new Date(`${fila.dia}T12:00:00`).getDay()]} {fechaCorta(String(fila.dia))}
            </div>
            {series.map((s) => (
              <div key={s.clave} className="fila e chico" style={{ gap: 12 }}>
                <span className="fila" style={{ gap: 6 }}><span className="punto" style={{ color: s.color }} />{s.texto}</span>
                <b className="ds-numeric">{(Number(fila[s.clave]) || 0).toLocaleString("es-CO")}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Barras horizontales con rótulo y valor (magnitud de una sola serie, un solo color). */
export function BarrasH({ filas, vacio = "Sin datos" }: { filas: { etiqueta: string; valor: number }[]; vacio?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  if (!filas.length) return <p className="tenue">{vacio}</p>;
  const max = Math.max(1, ...filas.map((f) => f.valor));
  const total = filas.reduce((a, f) => a + f.valor, 0);
  return (
    <div className="pila c" role="list">
      {filas.map((f) => (
        <div key={f.etiqueta} role="listitem" className="pila" style={{ gap: 4 }}
          onMouseEnter={() => setHover(f.etiqueta)} onMouseLeave={() => setHover(null)}
          title={`${f.etiqueta}: ${f.valor.toLocaleString("es-CO")} (${Math.round((f.valor / total) * 1000) / 10}%)`}>
          <div className="fila e chico">
            <span className="trunc crece">{f.etiqueta}</span>
            <span className="ds-numeric">
              {f.valor.toLocaleString("es-CO")}
              <span className="tenue"> · {Math.round((f.valor / total) * 1000) / 10}%</span>
            </span>
          </div>
          <div className="barra-h" style={{ height: 8 }}>
            <span style={{ width: `${(f.valor / max) * 100}%`, borderRadius: "0 4px 4px 0", opacity: hover && hover !== f.etiqueta ? 0.5 : 1 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
