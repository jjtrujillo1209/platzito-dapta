// Conocimiento: cerebros (knowledge base) y sus fuentes.
import { useState, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import {
  Banner, Boton, Campo, Cargando, Encabezado, Icono, Insignia, Modal, Pestanas, Tarjeta, Vacio, fmt, useAvisos,
  useCarga, useIntervalo, type TonoInsignia,
} from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Cerebro, Fuente } from "../tipos";

const ESTADO_FUENTE: Record<Fuente["estado"], { tono: TonoInsignia; texto: string }> = {
  pendiente: { tono: "", texto: "Pendiente" },
  procesando: { tono: "info", texto: "Procesando" },
  lista: { tono: "ok", texto: "Lista" },
  fallida: { tono: "error", texto: "Fallida" },
};
const ICONO_FUENTE: Record<Fuente["tipo"], string> = { url: "link", sitemap: "account_tree", archivo: "draft", texto: "notes" };
const EXTENSIONES = ".pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.html,.htm,.json";

function NuevoCerebro({ onCerrar, onListo }: { onCerrar: () => void; onListo: (c: Cerebro) => void }) {
  const avisar = useAvisos();
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const crear = async () => {
    try {
      onListo(await api.post<Cerebro>("/api/cerebros", { nombre, descripcion }));
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  return (
    <Modal titulo="Nuevo cerebro" onCerrar={onCerrar} pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!nombre.trim()} onClick={crear}>Crear</Boton></>}>
      <Campo etiqueta="Nombre" ayuda="Máximo 80 caracteres"><input type="text" maxLength={80} autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
      <Campo etiqueta="Descripción"><textarea rows={3} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} /></Campo>
    </Modal>
  );
}

function ListaCerebros() {
  const { puede } = useSesion();
  const navegar = useNavigate();
  const { datos, cargando, error } = useCarga<Cerebro[]>(() => api.get("/api/cerebros"), []);
  const [nuevo, setNuevo] = useState(false);
  return (
    <div className="pagina">
      <Encabezado
        titulo="Conocimiento"
        descripcion="Cerebros con la información de tu empresa. Los agentes los consultan en texto y en voz con la herramienta buscar_conocimiento."
        acciones={puede("editor") && <Boton variante="primario" icono="add" onClick={() => setNuevo(true)}>Nuevo cerebro</Boton>}
      />
      {error && <Banner tono="error" icono="error">{error}</Banner>}
      {cargando && !datos ? <Cargando /> : (datos ?? []).length === 0 ? (
        <Tarjeta>
          <Vacio icono="psychology" titulo="Aún no hay cerebros" accion={puede("editor") && <Boton variante="primario" icono="add" onClick={() => setNuevo(true)}>Crear el primero</Boton>}>
            Sube tu web, sitemap, PDFs, hojas de cálculo o texto. Se fragmentan y se indexan con embeddings para que el agente responda sin inventar.
          </Vacio>
        </Tarjeta>
      ) : (
        <div className="rejilla c3">
          {(datos ?? []).map((c) => (
            <Link key={c.id} to={`/conocimiento/${c.id}`} className="tarjeta" style={{ color: "inherit", textDecoration: "none" }}>
              <div className="pila c">
                <div className="fila"><Icono n="psychology" /><b className="ds-title-md">{c.nombre}</b></div>
                {c.descripcion && <span className="tenue chico">{c.descripcion}</span>}
                <div className="fila">
                  <Insignia>{c.n_fuentes ?? 0} fuentes</Insignia>
                  <Insignia tono="primaria">{fmt.numero(c.n_fragmentos)} fragmentos</Insignia>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {nuevo && <NuevoCerebro onCerrar={() => setNuevo(false)} onListo={(c) => navegar(`/conocimiento/${c.id}`)} />}
    </div>
  );
}

type TipoAlta = "url" | "sitemap" | "archivo" | "texto";

function AgregarFuente({ cerebroId, onCerrar, onListo }: { cerebroId: number; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [tipo, setTipo] = useState<TipoAlta>("url");
  const [url, setUrl] = useState("");
  const [nombre, setNombre] = useState("");
  const [texto, setTexto] = useState("");
  const [maxPaginas, setMaxPaginas] = useState(50);
  const [descubiertas, setDescubiertas] = useState<string[] | null>(null);
  const [elegidas, setElegidas] = useState<Set<string>>(new Set());
  const [filtro, setFiltro] = useState("");
  const [archivos, setArchivos] = useState<File[]>([]);
  const [arrastrando, setArrastrando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const descubrir = async () => {
    setEnviando(true);
    try {
      const r = await api.post<{ urls: string[] }>("/api/cerebros/sitemap/descubrir", { url, max: 500 });
      setDescubiertas(r.urls);
      setElegidas(new Set(r.urls.slice(0, maxPaginas)));
      if (!r.urls.length) avisar("No se encontraron páginas en el sitemap", true);
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };

  const enviar = async () => {
    setEnviando(true);
    try {
      if (tipo === "archivo") {
        for (const a of archivos) {
          const fd = new FormData();
          fd.append("archivo", a);
          await api.subir(`/api/cerebros/${cerebroId}/archivos`, fd);
        }
      } else if (tipo === "sitemap") {
        await api.post(`/api/cerebros/${cerebroId}/fuentes`, { tipo, url, nombre: nombre || url, urls: [...elegidas], max_paginas: Math.max(1, elegidas.size || maxPaginas) });
      } else if (tipo === "url") {
        await api.post(`/api/cerebros/${cerebroId}/fuentes`, { tipo, url, nombre: nombre || url });
      } else {
        await api.post(`/api/cerebros/${cerebroId}/fuentes`, { tipo, nombre: nombre || "Texto", texto });
      }
      avisar("Fuente agregada: se está procesando");
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };

  const soltar = (e: DragEvent) => {
    e.preventDefault();
    setArrastrando(false);
    setArchivos([...archivos, ...Array.from(e.dataTransfer.files)]);
  };

  const valido =
    (tipo === "url" && /^https?:\/\//.test(url)) ||
    (tipo === "sitemap" && /^https?:\/\//.test(url) && (descubiertas === null || elegidas.size > 0)) ||
    (tipo === "archivo" && archivos.length > 0) ||
    (tipo === "texto" && texto.trim().length > 0);
  const visibles = (descubiertas ?? []).filter((u) => !filtro || u.includes(filtro));

  return (
    <Modal grande titulo="Agregar fuente" onCerrar={onCerrar} pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={enviando} disabled={!valido} onClick={enviar}>Agregar</Boton></>}>
      <Pestanas<TipoAlta> valor={tipo} onCambio={setTipo} opciones={[
        { id: "url", texto: "Página web", icono: "link" },
        { id: "sitemap", texto: "Sitemap", icono: "account_tree" },
        { id: "archivo", texto: "Archivos", icono: "upload_file" },
        { id: "texto", texto: "Texto", icono: "notes" },
      ]} />
      {tipo !== "archivo" && (
        <Campo etiqueta="Nombre (opcional)"><input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
      )}
      {tipo === "url" && (
        <Campo etiqueta="URL" ayuda="Se extrae el contenido principal de la página">
          <input type="url" placeholder="https://tuempresa.com/precios" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
        </Campo>
      )}
      {tipo === "sitemap" && (
        <>
          <div className="fila" style={{ alignItems: "flex-end" }}>
            <Campo etiqueta="Sitio o sitemap.xml" className="crece">
              <input type="url" placeholder="https://tuempresa.com" value={url} onChange={(e) => { setUrl(e.target.value.trim()); setDescubiertas(null); }} />
            </Campo>
            <Campo etiqueta="Máx. páginas"><input type="number" min={1} max={500} value={maxPaginas} onChange={(e) => setMaxPaginas(Number(e.target.value))} style={{ width: 110 }} /></Campo>
            <Boton icono="travel_explore" cargando={enviando && descubiertas === null} disabled={!/^https?:\/\//.test(url)} onClick={descubrir}>Descubrir páginas</Boton>
          </div>
          {descubiertas !== null && (
            <div className="pila c">
              <div className="fila e">
                <span className="chico tenue">{elegidas.size} de {descubiertas.length} páginas seleccionadas</span>
                <div className="acciones">
                  <input type="search" placeholder="Filtrar…" value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ width: 200 }} />
                  <Boton chico onClick={() => setElegidas(new Set([...elegidas, ...visibles]))}>Todas</Boton>
                  <Boton chico onClick={() => setElegidas(new Set([...elegidas].filter((u) => !visibles.includes(u))))}>Ninguna</Boton>
                </div>
              </div>
              <div className="tabla-env" style={{ maxHeight: 280, overflowY: "auto", padding: "var(--padding-8)" }}>
                {visibles.map((u) => (
                  <label key={u} className="check chico" style={{ display: "flex", padding: "2px 0" }}>
                    <input type="checkbox" checked={elegidas.has(u)} onChange={(e) => {
                      const s = new Set(elegidas);
                      if (e.target.checked) s.add(u); else s.delete(u);
                      setElegidas(s);
                    }} />
                    <span className="trunc mono">{u}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {descubiertas === null && <p className="chico tenue">Si no descubres páginas, se rastrean hasta {maxPaginas} del sitemap automáticamente.</p>}
        </>
      )}
      {tipo === "archivo" && (
        <>
          <label
            onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
            onDragLeave={() => setArrastrando(false)}
            onDrop={soltar}
            className="vacio"
            style={{ border: `2px dashed ${arrastrando ? "var(--primary)" : "var(--outline-variant)"}`, borderRadius: "var(--radius-2xl)", cursor: "pointer" }}
          >
            <Icono n="upload_file" />
            <h3>Arrastra archivos o haz clic</h3>
            <span className="chico">PDF, DOCX, XLSX, CSV, TXT, MD, HTML o JSON · hasta 25 MB</span>
            <input type="file" multiple accept={EXTENSIONES} style={{ display: "none" }} onChange={(e) => setArchivos([...archivos, ...Array.from(e.target.files ?? [])])} />
          </label>
          {archivos.map((a, i) => (
            <div key={i} className="fila e">
              <span className="trunc"><Icono n="draft" /> {a.name} <span className="tenue chico">({Math.round(a.size / 1024)} KB)</span></span>
              <Boton chico variante="texto" icono="close" onClick={() => setArchivos(archivos.filter((_, j) => j !== i))} aria-label="Quitar" />
            </div>
          ))}
        </>
      )}
      {tipo === "texto" && (
        <Campo etiqueta="Contenido" ayuda="Preguntas frecuentes, políticas, guiones, lo que el agente deba saber">
          <textarea rows={12} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </Campo>
      )}
    </Modal>
  );
}

function Fragmentos({ fuente, onCerrar }: { fuente: Fuente; onCerrar: () => void }) {
  const { datos, cargando } = useCarga<{ id: number; orden: number; titulo: string; url: string; texto: string }[]>(
    () => api.get(`/api/cerebros/fuentes/${fuente.id}/fragmentos`), [fuente.id]);
  return (
    <Modal grande titulo={`Fragmentos · ${fuente.nombre}`} onCerrar={onCerrar}>
      {cargando ? <Cargando /> : (datos ?? []).length === 0 ? <p className="tenue">Sin fragmentos.</p> : (datos ?? []).map((f) => (
        <div key={f.id} className="tarjeta plana pila c">
          <div className="fila e chico tenue"><span>#{f.orden + 1} · {f.titulo}</span>{f.url && <a href={f.url} target="_blank" rel="noreferrer">abrir</a>}</div>
          <pre className="chico">{f.texto}</pre>
        </div>
      ))}
    </Modal>
  );
}

function ProbarBusqueda({ cerebroId }: { cerebroId: number }) {
  const avisar = useAvisos();
  const [consulta, setConsulta] = useState("");
  const [topK, setTopK] = useState(5);
  const [resultados, setResultados] = useState<{ texto: string; titulo: string; url: string; puntaje: number }[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const buscar = async () => {
    setBuscando(true);
    try {
      setResultados(await api.post(`/api/cerebros/${cerebroId}/buscar`, { consulta, top_k: topK }));
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setBuscando(false);
    }
  };
  return (
    <Tarjeta titulo="Probar búsqueda" icono="search">
      <div className="pila">
        <form className="fila" onSubmit={(e) => { e.preventDefault(); buscar(); }}>
          <input type="search" className="crece" placeholder="Pregunta como lo haría un cliente…" value={consulta} onChange={(e) => setConsulta(e.target.value)} style={{ flex: 1 }} />
          <select value={topK} onChange={(e) => setTopK(Number(e.target.value))} style={{ width: 90 }} aria-label="Resultados">
            {[3, 5, 8, 12].map((n) => <option key={n} value={n}>top {n}</option>)}
          </select>
          <Boton variante="secundario" type="submit" cargando={buscando} disabled={!consulta.trim()}>Buscar</Boton>
        </form>
        {resultados !== null && (resultados.length === 0 ? <p className="tenue">Sin resultados.</p> : resultados.map((r, i) => (
          <div key={i} className="pila c" style={{ borderTop: "1px solid var(--outline-variant)", paddingTop: "var(--padding-8)" }}>
            <div className="fila e">
              <span className="trunc" style={{ fontWeight: 600 }}>{r.titulo || "Sin título"}</span>
              <Insignia tono={r.puntaje >= 0.5 ? "ok" : r.puntaje >= 0.35 ? "aviso" : ""}>{r.puntaje.toFixed(3)}</Insignia>
            </div>
            {r.url && <a className="chico trunc" href={r.url} target="_blank" rel="noreferrer">{r.url}</a>}
            <p className="chico tenue" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.texto.slice(0, 600)}{r.texto.length > 600 ? "…" : ""}</p>
          </div>
        )))}
        <p className="chico tenue" style={{ margin: 0 }}>El agente solo usa pasajes por encima de su umbral (0,35 por defecto, configurable en el agente).</p>
      </div>
    </Tarjeta>
  );
}

function DetalleCerebro({ id }: { id: number }) {
  const { puede } = useSesion();
  const avisar = useAvisos();
  const navegar = useNavigate();
  const { datos: cerebro, cargando, error, recargar } = useCarga<Cerebro>(() => api.get(`/api/cerebros/${id}`), [id]);
  const [agregar, setAgregar] = useState(false);
  const [verFrags, setVerFrags] = useState<Fuente | null>(null);
  const [editar, setEditar] = useState(false);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");

  const enProceso = (cerebro?.fuentes ?? []).some((f) => f.estado === "pendiente" || f.estado === "procesando");
  useIntervalo(recargar, enProceso ? 2500 : null);

  if (cargando && !cerebro) return <div className="pagina"><Cargando /></div>;
  if (error || !cerebro) return <div className="pagina"><Banner tono="error" icono="error">{error ?? "No encontrado"}</Banner></div>;
  const fuentes = cerebro.fuentes ?? [];
  const totalFrags = fuentes.reduce((s, f) => s + f.n_fragmentos, 0);

  const reintentar = async (f: Fuente) => {
    await api.post(`/api/cerebros/fuentes/${f.id}/reintentar`);
    recargar();
  };
  const borrarFuente = async (f: Fuente) => {
    if (!confirm(`¿Eliminar la fuente "${f.nombre}" y sus fragmentos?`)) return;
    await api.del(`/api/cerebros/fuentes/${f.id}`);
    recargar();
  };
  const guardar = async () => {
    try {
      await api.patch(`/api/cerebros/${id}`, { nombre, descripcion });
      setEditar(false);
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const borrar = async () => {
    if (!confirm(`¿Eliminar el cerebro "${cerebro.nombre}"? Los agentes que lo usan dejarán de consultarlo.`)) return;
    await api.del(`/api/cerebros/${id}`);
    navegar("/conocimiento");
  };

  return (
    <div className="pagina">
      <Encabezado
        titulo={<span className="fila"><Link to="/conocimiento" className="tenue"><Icono n="arrow_back" /></Link>{cerebro.nombre}</span>}
        descripcion={cerebro.descripcion || `${fuentes.length} fuentes · ${fmt.numero(totalFrags)} fragmentos`}
        acciones={
          <>
            {puede("editor") && <Boton icono="edit" onClick={() => { setNombre(cerebro.nombre); setDescripcion(cerebro.descripcion); setEditar(true); }}>Editar</Boton>}
            {puede("admin") && <Boton variante="peligro" icono="delete" onClick={borrar} aria-label="Eliminar cerebro" />}
            {puede("editor") && <Boton variante="primario" icono="add" onClick={() => setAgregar(true)}>Agregar fuente</Boton>}
          </>
        }
      />
      <div className="pila">
        {fuentes.length === 0 ? (
          <Tarjeta>
            <Vacio icono="library_add" titulo="Este cerebro está vacío" accion={puede("editor") && <Boton variante="primario" icono="add" onClick={() => setAgregar(true)}>Agregar fuente</Boton>}>
              Agrega páginas web, un sitemap completo, archivos o texto.
            </Vacio>
          </Tarjeta>
        ) : (
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Fuente</th><th>Estado</th><th className="num">Fragmentos</th><th>Actualizada</th><th /></tr></thead>
              <tbody>
                {fuentes.map((f) => (
                  <tr key={f.id}>
                    <td style={{ maxWidth: 460 }}>
                      <div className="fila" style={{ gap: "var(--gap-8)", flexWrap: "nowrap" }}>
                        <Icono n={ICONO_FUENTE[f.tipo]} />
                        <div className="crece">
                          <div className="trunc">{f.nombre}</div>
                          {f.url && f.url !== f.nombre && <div className="chico tenue trunc">{f.url}</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <Insignia tono={ESTADO_FUENTE[f.estado].tono}>
                        {f.estado === "procesando" && <Icono n="progress_activity" className="giro" />}
                        {ESTADO_FUENTE[f.estado].texto}
                      </Insignia>
                      {f.error && <div className="chico" style={{ color: "var(--error)", marginTop: 4, maxWidth: 320 }}>{f.error}</div>}
                    </td>
                    <td className="num">{fmt.numero(f.n_fragmentos)}</td>
                    <td className="chico tenue">{fmt.relativa(f.actualizado)}</td>
                    <td>
                      <div className="acciones" style={{ justifyContent: "flex-end" }}>
                        {f.n_fragmentos > 0 && <Boton chico variante="texto" icono="visibility" onClick={() => setVerFrags(f)} aria-label="Ver fragmentos" />}
                        {puede("editor") && f.estado !== "procesando" && <Boton chico variante="texto" icono="refresh" onClick={() => reintentar(f)} aria-label="Reprocesar" />}
                        {puede("editor") && <Boton chico variante="texto" icono="delete" onClick={() => borrarFuente(f)} aria-label="Eliminar" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalFrags > 0 && <ProbarBusqueda cerebroId={id} />}
      </div>
      {agregar && <AgregarFuente cerebroId={id} onCerrar={() => setAgregar(false)} onListo={() => { setAgregar(false); recargar(); }} />}
      {verFrags && <Fragmentos fuente={verFrags} onCerrar={() => setVerFrags(null)} />}
      {editar && (
        <Modal titulo="Editar cerebro" onCerrar={() => setEditar(false)} pie={<><Boton onClick={() => setEditar(false)}>Cancelar</Boton><Boton variante="primario" disabled={!nombre.trim()} onClick={guardar}>Guardar</Boton></>}>
          <Campo etiqueta="Nombre"><input type="text" maxLength={80} value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
          <Campo etiqueta="Descripción"><textarea rows={3} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} /></Campo>
        </Modal>
      )}
    </div>
  );
}

export default function Conocimiento() {
  const { id } = useParams();
  return id ? <DetalleCerebro id={Number(id)} /> : <ListaCerebros />;
}
