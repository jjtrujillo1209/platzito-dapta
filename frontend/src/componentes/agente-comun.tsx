// Piezas compartidas por las pestañas del editor de agentes.
import { useState } from "react";
import { Boton, Check, Icono } from "./ui";
import type { Agente, ConfigAgente, Parametro } from "../tipos";

export interface PropsPestana {
  agente: Agente;
  cfg: ConfigAgente;
  setCfg: (c: ConfigAgente) => void;
  editable: boolean;
}

/** Input numérico que acepta vacío mientras se escribe. */
export function Num({ valor, onCambio, min, max, paso, disabled }: {
  valor: number | null | undefined; onCambio: (v: number) => void; min?: number; max?: number; paso?: number; disabled?: boolean;
}) {
  return (
    <input type="number" value={valor ?? ""} min={min} max={max} step={paso ?? 1} disabled={disabled}
      onChange={(e) => e.target.value !== "" && onCambio(Number(e.target.value))} />
  );
}

/** Deslizador con valor visible. */
export function Deslizador({ valor, onCambio, min, max, paso, disabled }: {
  valor: number; onCambio: (v: number) => void; min: number; max: number; paso: number; disabled?: boolean;
}) {
  return (
    <div className="fila" style={{ flexWrap: "nowrap" }}>
      <input type="range" min={min} max={max} step={paso} value={valor} disabled={disabled}
        onChange={(e) => onCambio(Number(e.target.value))} />
      <span className="mono" style={{ minWidth: 40, textAlign: "right" }}>{valor}</span>
    </div>
  );
}

/** Editor de pares clave/valor. */
export function EditorKV({ valor, onCambio, disabled, placeholderClave = "clave", placeholderValor = "valor" }: {
  valor: Record<string, string>; onCambio: (v: Record<string, string>) => void; disabled?: boolean;
  placeholderClave?: string; placeholderValor?: string;
}) {
  const filas = Object.entries(valor);
  const [nuevaClave, setNuevaClave] = useState("");
  const set = (entradas: [string, string][]) => onCambio(Object.fromEntries(entradas));
  return (
    <div className="pila c">
      {filas.map(([k, v], i) => (
        <div key={i} className="fila" style={{ flexWrap: "nowrap" }}>
          <input type="text" value={k} disabled={disabled} style={{ maxWidth: 220 }} className="mono"
            onChange={(e) => set(filas.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
          <input type="text" value={v} disabled={disabled} placeholder={placeholderValor}
            onChange={(e) => set(filas.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
          {!disabled && <Boton chico icono="delete" title="Quitar" onClick={() => set(filas.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {!disabled && (
        <div className="fila" style={{ flexWrap: "nowrap" }}>
          <input type="text" value={nuevaClave} placeholder={placeholderClave} style={{ maxWidth: 220 }} className="mono"
            onChange={(e) => setNuevaClave(e.target.value.replace(/\s/g, "_"))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nuevaClave) { e.preventDefault(); onCambio({ ...valor, [nuevaClave]: "" }); setNuevaClave(""); }
            }} />
          <Boton chico icono="add" disabled={!nuevaClave || nuevaClave in valor}
            onClick={() => { onCambio({ ...valor, [nuevaClave]: "" }); setNuevaClave(""); }}>Agregar</Boton>
        </div>
      )}
    </div>
  );
}

const TIPOS_PARAM: Parametro["tipo"][] = ["texto", "numero", "booleano", "fecha", "email", "telefono", "enum"];

/** Editor de parámetros tipados que el LLM llena al usar una herramienta. */
export function EditorParametros({ valor, onCambio, disabled }: { valor: Parametro[]; onCambio: (v: Parametro[]) => void; disabled?: boolean }) {
  const cambiar = (i: number, p: Partial<Parametro>) => onCambio(valor.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="pila c">
      {valor.length === 0 && <span className="chico tenue">Sin parámetros.</span>}
      {valor.map((p, i) => (
        <div key={i} className="tarjeta plana" style={{ padding: "var(--padding-12)" }}>
          <div className="fila" style={{ flexWrap: "nowrap" }}>
            <input type="text" className="mono" placeholder="nombre" value={p.nombre} disabled={disabled} style={{ maxWidth: 180 }}
              onChange={(e) => cambiar(i, { nombre: e.target.value.replace(/\s/g, "_") })} />
            <select value={p.tipo} disabled={disabled} style={{ maxWidth: 130 }} onChange={(e) => cambiar(i, { tipo: e.target.value as Parametro["tipo"] })}>
              {TIPOS_PARAM.map((t) => <option key={t}>{t}</option>)}
            </select>
            <input type="text" placeholder="Descripción para el modelo" value={p.descripcion} disabled={disabled}
              onChange={(e) => cambiar(i, { descripcion: e.target.value })} />
            <Check valor={p.requerido} onCambio={(v) => !disabled && cambiar(i, { requerido: v })}>Req.</Check>
            {!disabled && <Boton chico icono="delete" onClick={() => onCambio(valor.filter((_, j) => j !== i))} />}
          </div>
          {p.tipo === "enum" && (
            <input type="text" style={{ marginTop: 8 }} placeholder="Opciones separadas por coma" disabled={disabled}
              value={p.opciones.join(", ")}
              onChange={(e) => cambiar(i, { opciones: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
          )}
        </div>
      ))}
      {!disabled && (
        <Boton chico icono="add" onClick={() => onCambio([...valor, { nombre: "", tipo: "texto", descripcion: "", requerido: true, opciones: [] }])}>
          Parámetro
        </Boton>
      )}
    </div>
  );
}

export function Ayuda({ children }: { children: React.ReactNode }) {
  return (
    <div className="chico tenue fila" style={{ gap: "var(--gap-4)", flexWrap: "nowrap", alignItems: "flex-start" }}>
      <Icono n="info" /> <span>{children}</span>
    </div>
  );
}
