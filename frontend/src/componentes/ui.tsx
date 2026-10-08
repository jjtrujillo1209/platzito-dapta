// Componentes base reutilizables. Todas las páginas los usan para mantener un solo lenguaje visual.
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

export function Icono({ n, fill, className = "", titulo }: { n: string; fill?: boolean; className?: string; titulo?: string }) {
  return (
    <span className={`ms ${fill ? "fill" : ""} ${className}`} aria-hidden={!titulo} title={titulo}>
      {n}
    </span>
  );
}

type VarianteBoton = "primario" | "secundario" | "contorno" | "texto" | "peligro" | "";

export function Boton({
  children, icono, variante = "", chico, cargando, className = "", ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icono?: string; variante?: VarianteBoton; chico?: boolean; cargando?: boolean }) {
  const soloIcono = !children && icono;
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || cargando}
      className={`btn ${variante} ${chico ? "chico" : ""} ${soloIcono ? "icono" : ""} ${className}`}
    >
      {cargando ? <Icono n="progress_activity" className="giro" /> : icono ? <Icono n={icono} /> : null}
      {children}
    </button>
  );
}

export function Campo({ etiqueta, ayuda, children, className = "" }: { etiqueta?: ReactNode; ayuda?: ReactNode; children: ReactNode; className?: string }) {
  // Asocia la etiqueta y la ayuda al control (lectores de pantalla y clic en la etiqueta)
  const base = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(children)
    && ["input", "select", "textarea"].includes(children.type as string) ? children : null;
  const id = control?.props.id ?? `${base}-c`;
  const hijo = control ? cloneElement(control, { id, "aria-describedby": ayuda ? `${base}-a` : control.props["aria-describedby"] }) : children;
  return (
    <div className={`campo ${className}`}>
      {etiqueta && <label htmlFor={control ? id : undefined}>{etiqueta}</label>}
      {hijo}
      {ayuda && <span className="ayuda" id={`${base}-a`}>{ayuda}</span>}
    </div>
  );
}

export function Check({ valor, onCambio, children }: { valor: boolean; onCambio: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={valor} onChange={(e) => onCambio(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function Tarjeta({ titulo, icono, acciones, children, className = "" }: { titulo?: ReactNode; icono?: string; acciones?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`tarjeta ${className}`}>
      {(titulo || acciones) && (
        <div className="fila e" style={{ marginBottom: "var(--gap-12)" }}>
          {titulo && (
            <h3 style={{ margin: 0 }}>
              {icono && <Icono n={icono} />}
              {titulo}
            </h3>
          )}
          {acciones && <div className="acciones">{acciones}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Encabezado({ titulo, descripcion, acciones }: { titulo: ReactNode; descripcion?: ReactNode; acciones?: ReactNode }) {
  return (
    <header className="encabezado">
      <div>
        <h1>{titulo}</h1>
        {descripcion && <p>{descripcion}</p>}
      </div>
      {acciones && <div className="acciones">{acciones}</div>}
    </header>
  );
}

export type TonoInsignia = "ok" | "aviso" | "error" | "info" | "primaria" | "";
export function Insignia({ tono = "", children, punto }: { tono?: TonoInsignia; children: ReactNode; punto?: boolean }) {
  return (
    <span className={`insignia ${tono}`}>
      {punto && <span className="punto" />}
      {children}
    </span>
  );
}

export function Modal({ titulo, onCerrar, children, pie, grande }: { titulo: ReactNode; onCerrar: () => void; children: ReactNode; pie?: ReactNode; grande?: boolean }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onCerrar]);
  return (
    <div className="velo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className={`modal ${grande ? "grande" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-cab">
          <h2>{titulo}</h2>
          <Boton icono="close" variante="texto" onClick={onCerrar} aria-label="Cerrar" />
        </div>
        <div className="modal-cuerpo">{children}</div>
        {pie && <div className="modal-pie">{pie}</div>}
      </div>
    </div>
  );
}

export function Cajon({ titulo, onCerrar, children, pie }: { titulo: ReactNode; onCerrar: () => void; children: ReactNode; pie?: ReactNode }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onCerrar]);
  return (
    <>
      <div className="velo" style={{ background: "transparent" }} onMouseDown={onCerrar} />
      <aside className="cajon">
        <div className="modal-cab">
          <h2>{titulo}</h2>
          <Boton icono="close" variante="texto" onClick={onCerrar} aria-label="Cerrar" />
        </div>
        <div className="modal-cuerpo">{children}</div>
        {pie && <div className="modal-pie">{pie}</div>}
      </aside>
    </>
  );
}

export function Vacio({ icono = "inbox", titulo, children, accion }: { icono?: string; titulo: ReactNode; children?: ReactNode; accion?: ReactNode }) {
  return (
    <div className="vacio">
      <Icono n={icono} />
      <h3>{titulo}</h3>
      {children && <div style={{ maxWidth: 460 }}>{children}</div>}
      {accion}
    </div>
  );
}

export function Cargando({ texto = "Cargando…" }: { texto?: string }) {
  return (
    <div className="cargando">
      <Icono n="progress_activity" className="giro" /> {texto}
    </div>
  );
}

export function Banner({ tono = "", icono = "info", children }: { tono?: "" | "aviso" | "error" | "ok"; icono?: string; children: ReactNode }) {
  return (
    <div className={`banner ${tono}`}>
      <Icono n={icono} />
      <div className="crece">{children}</div>
    </div>
  );
}

export function Pestanas<T extends string>({ valor, onCambio, opciones }: { valor: T; onCambio: (v: T) => void; opciones: { id: T; texto: string; icono?: string }[] }) {
  return (
    <div className="pestanas" role="tablist">
      {opciones.map((o) => (
        <button key={o.id} role="tab" className={`pestana ${valor === o.id ? "activa" : ""}`} onClick={() => onCambio(o.id)}>
          {o.icono && <Icono n={o.icono} />}
          {o.texto}
        </button>
      ))}
    </div>
  );
}

export function Kpi({ etiqueta, valor, nota }: { etiqueta: string; valor: ReactNode; nota?: ReactNode }) {
  return (
    <div className="tarjeta kpi">
      <span className="etiqueta">{etiqueta}</span>
      <span className="valor">{valor}</span>
      {nota && <span className="nota">{nota}</span>}
    </div>
  );
}

/** Lista editable de textos (etiquetas, palabras clave…). */
export function ListaTextos({ valor, onCambio, placeholder }: { valor: string[]; onCambio: (v: string[]) => void; placeholder?: string }) {
  const [nuevo, setNuevo] = useState("");
  const agregar = () => {
    const t = nuevo.trim();
    if (t && !valor.includes(t)) onCambio([...valor, t]);
    setNuevo("");
  };
  return (
    <div className="pila c">
      <div className="fila" style={{ gap: "var(--gap-4)" }}>
        {valor.map((v) => (
          <span key={v} className="insignia">
            {v}
            <button className="btn texto chico" style={{ height: 18, padding: 0 }} onClick={() => onCambio(valor.filter((x) => x !== v))} aria-label={`Quitar ${v}`}>
              <Icono n="close" />
            </button>
          </span>
        ))}
      </div>
      <input type="text" value={nuevo} placeholder={placeholder ?? "Escribe y presiona Enter"} onChange={(e) => setNuevo(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); agregar(); } }} onBlur={agregar} />
    </div>
  );
}

// ───────── Avisos (toasts) ─────────

type Aviso = { id: number; texto: string; error?: boolean };
const CtxAvisos = createContext<(texto: string, error?: boolean) => void>(() => {});

export function ProveedorAvisos({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const n = useRef(0);
  const avisar = useCallback((texto: string, error = false) => {
    const id = ++n.current;
    setAvisos((a) => [...a, { id, texto, error }]);
    setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <CtxAvisos.Provider value={avisar}>
      {children}
      <div className="avisos" aria-live="polite">
        {avisos.map((a) => (
          <div key={a.id} className={`toast ${a.error ? "error" : ""}`}>
            <Icono n={a.error ? "error" : "check_circle"} />
            <span>{a.texto}</span>
          </div>
        ))}
      </div>
    </CtxAvisos.Provider>
  );
}

export const useAvisos = () => useContext(CtxAvisos);

// ───────── Datos asíncronos ─────────

/** Carga datos y expone recargar. `deps` dispara recargas. */
export function useCarga<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const vivo = useRef(true);
  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      const d = await fn();
      if (vivo.current) { setDatos(d); setError(null); }
    } catch (e) {
      if (vivo.current) setError((e as Error).message);
    } finally {
      if (vivo.current) setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    vivo.current = true;
    recargar();
    return () => { vivo.current = false; };
  }, [recargar]);
  return { datos, setDatos, error, cargando, recargar };
}

/** Ejecuta `fn` cada `ms` mientras el componente esté montado y la pestaña visible. */
export function useIntervalo(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ───────── Formato ─────────

export const fmt = {
  fecha(iso?: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
  },
  relativa(iso?: string | null) {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    const futuro = s < 0;
    const a = Math.abs(s);
    const t = a < 60 ? "segundos" : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
    return futuro ? `en ${t}` : `hace ${t}`;
  },
  numero: (n?: number | null) => (n ?? 0).toLocaleString("es-CO"),
  pct: (n?: number | null) => `${Math.round((n ?? 0) * 1000) / 10}%`,
  usd: (n?: number | null) => `US$${(n ?? 0).toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`,
  duracion(s?: number | null) {
    const t = Math.round(s ?? 0);
    return t >= 60 ? `${Math.floor(t / 60)}m ${t % 60}s` : `${t}s`;
  },
};

export const CANALES: Record<string, { texto: string; icono: string }> = {
  whatsapp: { texto: "WhatsApp", icono: "chat" },
  widget: { texto: "Web", icono: "language" },
  voz: { texto: "Voz", icono: "call" },
  correo: { texto: "Correo", icono: "mail" },
  sms: { texto: "SMS", icono: "sms" },
  playground: { texto: "Pruebas", icono: "science" },
  simulador: { texto: "Simulador", icono: "smart_toy" },
};

export const RESULTADOS_LLAMADA: Record<string, { texto: string; tono: TonoInsignia }> = {
  contestada: { texto: "Contestada", tono: "ok" },
  no_contesta: { texto: "No contestó", tono: "aviso" },
  ocupado: { texto: "Ocupado", tono: "aviso" },
  buzon: { texto: "Buzón", tono: "info" },
  fallida: { texto: "Fallida", tono: "error" },
  "": { texto: "En curso", tono: "primaria" },
};
