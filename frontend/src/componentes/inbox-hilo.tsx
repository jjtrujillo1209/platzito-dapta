// Hilo de mensajes reutilizable (Inbox y transcript de llamadas).
import { fmt, Icono } from "./ui";
import type { Mensaje } from "../tipos";

const ENTREGA: Record<string, { icono: string; titulo: string }> = {
  enviado: { icono: "check", titulo: "Enviado" },
  entregado: { icono: "done_all", titulo: "Entregado" },
  leido: { icono: "done_all", titulo: "Leído" },
  fallido: { icono: "error", titulo: "Falló" },
};

function Herramientas({ m }: { m: Mensaje }) {
  const resultados: { nombre: string; args: unknown; resultado: string }[] = m.datos?.resultados ?? [];
  const llamadas: { nombre: string; args: unknown }[] = m.datos?.llamadas ?? [];
  const lista = resultados.length ? resultados : llamadas.map((l) => ({ ...l, resultado: "" }));
  return (
    <>
      {m.contenido && <div className="burbuja saliente">{m.contenido}</div>}
      {lista.map((r, i) => (
        <details key={i} className="herramienta-chip">
          <summary>
            <Icono n="build" /> {r.nombre}
          </summary>
          <pre className="chico">{JSON.stringify(r.args, null, 1)}</pre>
          {r.resultado && <pre className="chico" style={{ marginTop: 4, opacity: 0.85 }}>{String(r.resultado).slice(0, 1500)}</pre>}
        </details>
      ))}
    </>
  );
}

export default function Hilo({
  mensajes,
  onCalificar,
}: {
  mensajes: Mensaje[];
  onCalificar?: (m: Mensaje, valor: number) => void;
}) {
  return (
    <div className="chat">
      {mensajes.map((m) => {
        if (m.tipo === "herramienta") return <Herramientas key={m.id} m={m} />;
        if (m.tipo === "nota")
          return (
            <div key={m.id} className={`burbuja ${m.autor === "sistema" ? "sistema" : "nota"}`}>
              {m.autor === "humano" && <Icono n="sticky_note_2" />} {m.contenido}
            </div>
          );
        const saliente = m.direccion === "saliente";
        const entrega = ENTREGA[m.estado_entrega];
        return (
          <div key={m.id} className={`burbuja ${saliente ? "saliente" : "entrante"} ${m.autor === "humano" ? "humano" : ""}`}>
            {m.tipo === "plantilla" && (
              <div className="chico" style={{ opacity: 0.7 }}>
                <Icono n="description" /> Plantilla {m.datos?.plantilla ?? ""}
              </div>
            )}
            {m.tipo === "media" && <Icono n="attachment" />} {m.contenido}
            {m.datos?.fuentes?.length > 0 && (
              <div className="chico" style={{ marginTop: 4 }}>
                {(m.datos.fuentes as { titulo: string; url: string }[]).map((f, i) =>
                  f.url ? (
                    <a key={i} href={f.url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                      {f.titulo || f.url}
                    </a>
                  ) : null,
                )}
              </div>
            )}
            {m.error && <div className="chico" style={{ color: "var(--error)" }}>{m.error}</div>}
            <div className="meta">
              {saliente && <span>{m.autor === "ia" ? "IA" : m.autor === "humano" ? "Equipo" : "Sistema"}</span>}
              <span>{fmt.fecha(m.creado)}</span>
              {entrega && (
                <span title={entrega.titulo} style={m.estado_entrega === "leido" ? { color: "var(--info)" } : undefined}>
                  <Icono n={entrega.icono} />
                </span>
              )}
              {onCalificar && m.autor === "ia" && (
                <span className="calif">
                  <button className={m.calificacion === 1 ? "on" : ""} onClick={() => onCalificar(m, m.calificacion === 1 ? 0 : 1)} aria-label="Buena respuesta">
                    <Icono n="thumb_up" />
                  </button>
                  <button className={m.calificacion === -1 ? "on" : ""} onClick={() => onCalificar(m, m.calificacion === -1 ? 0 : -1)} aria-label="Mala respuesta">
                    <Icono n="thumb_down" />
                  </button>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
