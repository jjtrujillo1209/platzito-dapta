// Pestaña Plantillas de Canales: listado por carpeta, creación con vista previa y movimiento entre carpetas.
import { useMemo, useState } from "react";
import { api } from "../api";
import { useSesion } from "../sesion";
import type { Linea, Plantilla } from "../tipos";
import { Banner, Boton, Campo, Cargando, Icono, Insignia, Modal, Vacio, useAvisos, useCarga, type TonoInsignia } from "./ui";

const ESTADO: Record<string, { tono: TonoInsignia; texto: string }> = {
  APPROVED: { tono: "ok", texto: "Aprobada" },
  PENDING: { tono: "aviso", texto: "En revisión" },
  REJECTED: { tono: "error", texto: "Rechazada" },
  PAUSED: { tono: "aviso", texto: "Pausada" },
  DISABLED: { tono: "error", texto: "Deshabilitada" },
};

/** Resalta {{n}} dentro del cuerpo. */
export function CuerpoResaltado({ texto, ejemplos }: { texto: string; ejemplos?: string[] }) {
  const partes = texto.split(/(\{\{\d+\}\})/g);
  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {partes.map((p, i) => {
        const m = p.match(/^\{\{(\d+)\}\}$/);
        if (!m) return <span key={i}>{p}</span>;
        const ejemplo = ejemplos?.[Number(m[1]) - 1];
        return (
          <mark key={i} style={{ background: "var(--tertiary-container)", color: "var(--on-tertiary-container)", borderRadius: 4, padding: "0 3px" }}>
            {ejemplo || p}
          </mark>
        );
      })}
    </span>
  );
}

function variablesDe(cuerpo: string): number {
  return new Set(cuerpo.match(/\{\{(\d+)\}\}/g) ?? []).size;
}

function NuevaPlantilla({ lineas, carpetas, onCerrar, onListo }: { lineas: Linea[]; carpetas: string[]; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [f, setF] = useState({
    linea_id: lineas[0]?.id ?? 0, nombre: "", idioma: "es", categoria: "MARKETING", cuerpo: "Hola {{1}}, ", encabezado: "", pie: "", carpeta: "",
  });
  const [ejemplos, setEjemplos] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const n = variablesDe(f.cuerpo);
  const nombreValido = /^[a-z0-9_]{1,512}$/.test(f.nombre);

  const crear = async () => {
    setEnviando(true);
    try {
      await api.post("/api/plantillas", { ...f, ejemplos: ejemplos.slice(0, n) });
      avisar("Plantilla enviada a revisión de Meta");
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal grande titulo="Nueva plantilla" onCerrar={onCerrar} pie={
      <>
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" cargando={enviando} disabled={!nombreValido || !f.cuerpo.trim() || ejemplos.slice(0, n).filter(Boolean).length < n} onClick={crear}>
          Enviar a revisión
        </Boton>
      </>
    }>
      <div className="rejilla c2" style={{ alignItems: "start" }}>
        <div className="pila">
          <Campo etiqueta="Línea">
            <select value={f.linea_id} onChange={(e) => setF({ ...f, linea_id: Number(e.target.value) })}>
              {lineas.map((l) => <option key={l.id} value={l.id}>{l.numero_visible || l.phone_number_id}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Nombre" ayuda="Minúsculas, números y guion bajo">
            <input type="text" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
          </Campo>
          <div className="rejilla c2">
            <Campo etiqueta="Categoría">
              <select value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>
                <option value="MARKETING">Marketing</option>
                <option value="UTILITY">Utilidad</option>
                <option value="AUTHENTICATION">Autenticación</option>
              </select>
            </Campo>
            <Campo etiqueta="Idioma">
              <select value={f.idioma} onChange={(e) => setF({ ...f, idioma: e.target.value })}>
                <option value="es">Español</option>
                <option value="es_MX">Español (MX)</option>
                <option value="es_AR">Español (AR)</option>
                <option value="es_ES">Español (ES)</option>
                <option value="en">Inglés</option>
                <option value="pt_BR">Portugués (BR)</option>
              </select>
            </Campo>
          </div>
          <Campo etiqueta="Encabezado (opcional)"><input type="text" maxLength={60} value={f.encabezado} onChange={(e) => setF({ ...f, encabezado: e.target.value })} /></Campo>
          <Campo etiqueta="Cuerpo" ayuda="Usa {{1}}, {{2}}… para variables">
            <textarea rows={5} maxLength={1024} value={f.cuerpo} onChange={(e) => setF({ ...f, cuerpo: e.target.value })} />
          </Campo>
          {Array.from({ length: n }, (_, i) => (
            <Campo key={i} etiqueta={`Ejemplo para {{${i + 1}}}`}>
              <input type="text" value={ejemplos[i] ?? ""} onChange={(e) => { const c = [...ejemplos]; c[i] = e.target.value; setEjemplos(c); }} />
            </Campo>
          ))}
          <Campo etiqueta="Pie (opcional)"><input type="text" maxLength={60} value={f.pie} onChange={(e) => setF({ ...f, pie: e.target.value })} /></Campo>
          <Campo etiqueta="Carpeta">
            <input type="text" list="carpetas-plantillas" value={f.carpeta} onChange={(e) => setF({ ...f, carpeta: e.target.value })} />
            <datalist id="carpetas-plantillas">{carpetas.map((c) => <option key={c} value={c} />)}</datalist>
          </Campo>
        </div>
        <div className="pila c" style={{ position: "sticky", top: 0 }}>
          <span className="chico tenue">Vista previa</span>
          <div style={{ background: "var(--surf-cont-lowest)", borderRadius: "var(--radius-2xl)", padding: "var(--padding-16)", minHeight: 200 }}>
            <div className="burbuja entrante" style={{ maxWidth: "100%" }}>
              {f.encabezado && <div style={{ fontWeight: 700, marginBottom: 4 }}>{f.encabezado}</div>}
              <CuerpoResaltado texto={f.cuerpo} ejemplos={ejemplos} />
              {f.pie && <div className="chico tenue" style={{ marginTop: 6 }}>{f.pie}</div>}
            </div>
          </div>
          <p className="chico tenue">
            Fuera de la ventana de 24 h, Meta solo permite enviar plantillas aprobadas. Marketing se cobra más caro que
            utilidad y es lo primero que se pausa si cae la calidad de la línea.
          </p>
        </div>
      </div>
    </Modal>
  );
}

export default function CanalPlantillas() {
  const { puede } = useSesion();
  const avisar = useAvisos();
  const plantillas = useCarga<Plantilla[]>(() => api.get("/api/plantillas"), []);
  const lineas = useCarga<Linea[]>(() => api.get("/api/lineas"), []);
  const [nueva, setNueva] = useState(false);
  const [filtro, setFiltro] = useState("");
  const [sincronizando, setSincronizando] = useState(false);

  const grupos = useMemo(() => {
    const g = new Map<string, Plantilla[]>();
    for (const p of plantillas.datos ?? []) {
      if (filtro && !`${p.nombre} ${p.cuerpo}`.toLowerCase().includes(filtro.toLowerCase())) continue;
      const k = p.carpeta || "Sin carpeta";
      g.set(k, [...(g.get(k) ?? []), p]);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [plantillas.datos, filtro]);
  const carpetas = [...new Set((plantillas.datos ?? []).map((p) => p.carpeta).filter(Boolean))];
  const nombreLinea = (id: number) => {
    const l = lineas.datos?.find((x) => x.id === id);
    return l?.numero_visible || l?.phone_number_id || `#${id}`;
  };

  const mover = async (p: Plantilla) => {
    const carpeta = prompt("Carpeta (vacío para quitar)", p.carpeta);
    if (carpeta === null) return;
    try {
      await api.patch(`/api/plantillas/${p.id}`, { carpeta });
      plantillas.recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const sincronizarTodo = async () => {
    setSincronizando(true);
    try {
      for (const l of lineas.datos ?? []) await api.post(`/api/lineas/${l.id}/sincronizar`);
      avisar("Plantillas sincronizadas con Meta");
      plantillas.recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setSincronizando(false);
    }
  };

  if (plantillas.cargando && !plantillas.datos) return <Cargando />;
  const sinLineas = (lineas.datos ?? []).length === 0;
  return (
    <div className="pila">
      <div className="fila e">
        <input type="search" placeholder="Buscar plantilla…" value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ maxWidth: 320 }} />
        <div className="acciones">
          <Boton icono="sync" cargando={sincronizando} disabled={sinLineas} onClick={sincronizarTodo}>Sincronizar con Meta</Boton>
          {puede("editor") && <Boton variante="primario" icono="add" disabled={sinLineas} onClick={() => setNueva(true)}>Nueva plantilla</Boton>}
        </div>
      </div>
      {sinLineas && <Banner icono="info">Conecta una línea de WhatsApp para crear y sincronizar plantillas.</Banner>}
      {grupos.length === 0 ? (
        <Vacio icono="description" titulo="Sin plantillas">Las plantillas aprobadas se usan en campañas y para escribir fuera de la ventana de 24 h.</Vacio>
      ) : grupos.map(([carpeta, lista]) => (
        <div key={carpeta} className="pila c">
          <div className="fila tenue" style={{ fontWeight: 600 }}><Icono n="folder" />{carpeta} · {lista.length}</div>
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Nombre</th><th>Estado</th><th>Categoría</th><th>Cuerpo</th><th>Línea</th><th /></tr></thead>
              <tbody>
                {lista.map((p) => (
                  <tr key={p.id}>
                    <td><div className="mono">{p.nombre}</div><div className="chico tenue">{p.idioma} · {p.n_variables} variables</div></td>
                    <td>
                      <Insignia tono={ESTADO[p.estado]?.tono ?? ""}>{ESTADO[p.estado]?.texto ?? p.estado}</Insignia>
                      {p.motivo_rechazo && <div className="chico" style={{ color: "var(--error)", marginTop: 4 }}>{p.motivo_rechazo}</div>}
                    </td>
                    <td>{p.categoria}</td>
                    <td style={{ maxWidth: 420 }}><CuerpoResaltado texto={p.cuerpo} /></td>
                    <td className="chico">{nombreLinea(p.linea_id)}</td>
                    <td>{puede("editor") && <Boton chico variante="texto" icono="drive_file_move" onClick={() => mover(p)} aria-label="Mover a carpeta" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {nueva && <NuevaPlantilla lineas={lineas.datos ?? []} carpetas={carpetas} onCerrar={() => setNueva(false)} onListo={() => { setNueva(false); plantillas.recargar(); }} />}
    </div>
  );
}
