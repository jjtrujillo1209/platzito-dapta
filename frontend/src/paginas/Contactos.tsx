// Contactos: tabla con filtros, ficha con línea de tiempo, opt-out, inscripción masiva e importación CSV/XLSX.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, qs } from "../api";
import {
  Banner, Boton, CANALES, Cajon, Campo, Cargando, Encabezado, Icono, Insignia, ListaTextos, Modal,
  RESULTADOS_LLAMADA, Vacio, fmt, useAvisos, useCarga,
} from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Contacto, Conversacion, Inscripcion, Llamada, Secuencia } from "../tipos";

const POR_PAGINA = 50;

interface Listado { total: number; pagina: number; contactos: Contacto[]; etapas: string[]; etiquetas: string[] }
interface Detalle extends Contacto {
  conversaciones: Conversacion[];
  llamadas: Llamada[];
  inscripciones: (Inscripcion & { secuencia: string })[];
  citas: { id: number; inicio: string; duracion_min: number; estado: string; proveedor: string; notas: string }[];
}

// ───────── Formulario ─────────

function FormContacto({ inicial, onCerrar, onGuardado }: { inicial?: Contacto; onCerrar: () => void; onGuardado: (c: Contacto) => void }) {
  const avisar = useAvisos();
  const [f, setF] = useState({
    nombre: inicial?.nombre ?? "", telefono: inicial?.telefono ?? "", email: inicial?.email ?? "",
    empresa: inicial?.empresa ?? "", zona_horaria: inicial?.zona_horaria ?? "", etapa: inicial?.etapa ?? "nuevo",
    etiquetas: inicial?.etiquetas ?? [], atributos: Object.entries(inicial?.atributos ?? {}) as [string, string][],
  });
  const [guardando, setGuardando] = useState(false);
  const guardar = async () => {
    setGuardando(true);
    try {
      const cuerpo = { ...f, atributos: Object.fromEntries(f.atributos.filter(([k]) => k.trim())), zona_horaria: f.zona_horaria || null };
      const c = inicial ? await api.patch<Contacto>(`/api/contactos/${inicial.id}`, cuerpo) : await api.post<Contacto>("/api/contactos", cuerpo);
      avisar(inicial ? "Contacto actualizado" : "Contacto creado");
      onGuardado(c);
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setGuardando(false);
    }
  };
  const set = (k: "nombre" | "telefono" | "email" | "empresa" | "zona_horaria" | "etapa") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo={inicial ? "Editar contacto" : "Nuevo contacto"} onCerrar={onCerrar}
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={guardando} onClick={guardar}>Guardar</Boton></>}>
      <div className="rejilla c2">
        <Campo etiqueta="Nombre"><input type="text" value={f.nombre} onChange={set("nombre")} autoFocus /></Campo>
        <Campo etiqueta="Empresa"><input type="text" value={f.empresa} onChange={set("empresa")} /></Campo>
        <Campo etiqueta="Teléfono" ayuda="Con indicativo, p. ej. +57 300…"><input type="tel" value={f.telefono} onChange={set("telefono")} /></Campo>
        <Campo etiqueta="Correo"><input type="email" value={f.email} onChange={set("email")} /></Campo>
        <Campo etiqueta="Etapa"><input type="text" value={f.etapa} onChange={set("etapa")} /></Campo>
        <Campo etiqueta="Zona horaria" ayuda="Se deduce del teléfono si la dejas vacía"><input type="text" value={f.zona_horaria} placeholder="America/Bogota" onChange={set("zona_horaria")} /></Campo>
      </div>
      <Campo etiqueta="Etiquetas"><ListaTextos valor={f.etiquetas} onCambio={(etiquetas) => setF({ ...f, etiquetas })} /></Campo>
      <Campo etiqueta="Atributos" ayuda="Disponibles en los prompts y plantillas como {{nombre_atributo}}">
        <div className="pila c">
          {f.atributos.map(([k, v], i) => (
            <div key={i} className="fila" style={{ flexWrap: "nowrap" }}>
              <input type="text" placeholder="clave" value={k} onChange={(e) => setF({ ...f, atributos: f.atributos.map((a, j) => (j === i ? [e.target.value, a[1]] : a)) })} />
              <input type="text" placeholder="valor" value={v} onChange={(e) => setF({ ...f, atributos: f.atributos.map((a, j) => (j === i ? [a[0], e.target.value] : a)) })} />
              <Boton icono="delete" variante="texto" onClick={() => setF({ ...f, atributos: f.atributos.filter((_, j) => j !== i) })} aria-label="Quitar" />
            </div>
          ))}
          <Boton chico variante="contorno" icono="add" onClick={() => setF({ ...f, atributos: [...f.atributos, ["", ""]] })}>Atributo</Boton>
        </div>
      </Campo>
    </Modal>
  );
}

// ───────── Inscripción masiva ─────────

function Inscribir({ ids, onCerrar }: { ids: number[]; onCerrar: () => void }) {
  const avisar = useAvisos();
  const { datos } = useCarga(() => api.get<Secuencia[]>("/api/secuencias"), []);
  const [sec, setSec] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);
  const enviar = async () => {
    setEnviando(true);
    try {
      const r = await api.post<{ inscritos: number; omitidos: number }>(`/api/secuencias/${sec}/inscribir`, { contacto_ids: ids });
      avisar(`${r.inscritos} inscritos${r.omitidos ? ` · ${r.omitidos} ya estaban` : ""}`);
      onCerrar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Modal titulo={`Inscribir ${ids.length} contactos`} onCerrar={onCerrar}
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!sec} cargando={enviando} onClick={enviar}>Inscribir</Boton></>}>
      <Campo etiqueta="Campaña">
        <select value={sec ?? ""} onChange={(e) => setSec(Number(e.target.value) || null)}>
          <option value="">Elige una campaña…</option>
          {datos?.map((s) => <option key={s.id} value={s.id}>{s.nombre} ({s.estado})</option>)}
        </select>
      </Campo>
      {datos?.find((s) => s.id === sec)?.estado !== "activa" && sec && <Banner tono="aviso">La campaña no está activa: los contactos esperarán hasta que la actives.</Banner>}
    </Modal>
  );
}

// ───────── Importación ─────────

const DESTINOS = ["nombre", "telefono", "email", "empresa", "zona_horaria", "etapa", "ignorar"];

function Importar({ onCerrar, onListo }: { onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [archivo, setArchivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<{ columnas: string[]; mapeo: Record<string, string>; muestra: Record<string, string>[]; total: number } | null>(null);
  const [mapeo, setMapeo] = useState<Record<string, string>>({});
  const [etiquetas, setEtiquetas] = useState<string[]>([]);
  const [sec, setSec] = useState<number | null>(null);
  const [resultado, setResultado] = useState<{ creados: number; actualizados: number; invalidos: number; inscritos: number } | null>(null);
  const [cargando, setCargando] = useState(false);
  const { datos: secuencias } = useCarga(() => api.get<Secuencia[]>("/api/secuencias"), []);

  const previsualizar = async (a: File) => {
    setArchivo(a);
    setCargando(true);
    try {
      const fd = new FormData();
      fd.append("archivo", a);
      const p = await api.subir("/api/contactos/importar/previsualizar", fd);
      setPrevia(p);
      setMapeo(p.mapeo);
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setCargando(false);
    }
  };
  const importar = async () => {
    if (!archivo) return;
    setCargando(true);
    try {
      const fd = new FormData();
      fd.append("archivo", archivo);
      fd.append("mapeo", JSON.stringify(mapeo));
      fd.append("etiquetas", etiquetas.join(","));
      if (sec) fd.append("secuencia_id", String(sec));
      setResultado(await api.subir("/api/contactos/importar", fd));
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setCargando(false);
    }
  };
  const sinTelefonoNiCorreo = previa && !Object.values(mapeo).some((d) => d === "telefono" || d === "email");

  return (
    <Modal grande titulo="Importar contactos" onCerrar={onCerrar}
      pie={resultado ? <Boton variante="primario" onClick={onCerrar}>Listo</Boton> : (
        <><Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" icono="upload" disabled={!previa || !!sinTelefonoNiCorreo} cargando={cargando} onClick={importar}>
            Importar {previa ? `${fmt.numero(previa.total)} filas` : ""}
          </Boton></>
      )}>
      {resultado ? (
        <div className="rejilla c4">
          <div className="tarjeta kpi"><span className="etiqueta">Creados</span><span className="valor">{resultado.creados}</span></div>
          <div className="tarjeta kpi"><span className="etiqueta">Actualizados</span><span className="valor">{resultado.actualizados}</span></div>
          <div className="tarjeta kpi"><span className="etiqueta">Inválidos</span><span className="valor">{resultado.invalidos}</span><span className="nota">sin teléfono ni correo válido</span></div>
          <div className="tarjeta kpi"><span className="etiqueta">Inscritos</span><span className="valor">{resultado.inscritos}</span></div>
        </div>
      ) : (
        <>
          <Campo etiqueta="Archivo CSV o Excel" ayuda="Primera fila con encabezados. Teléfonos con o sin indicativo (se asume el país del espacio). Se deduplica por teléfono y correo.">
            <input type="file" accept=".csv,.xlsx,.xlsm,.txt" onChange={(e) => e.target.files?.[0] && previsualizar(e.target.files[0])} />
          </Campo>
          {cargando && !previa && <Cargando texto="Leyendo archivo…" />}
          {previa && (
            <>
              {sinTelefonoNiCorreo && <Banner tono="error">Mapea al menos una columna a teléfono o correo.</Banner>}
              <div className="tabla-env">
                <table className="tabla">
                  <thead>
                    <tr>{previa.columnas.map((c) => <th key={c}>{c}</th>)}</tr>
                    <tr>
                      {previa.columnas.map((c) => {
                        const v = mapeo[c] ?? "ignorar";
                        const esAtributo = v.startsWith("atributo:");
                        return (
                          <th key={c} style={{ fontWeight: 400 }}>
                            <select value={esAtributo ? "atributo" : v} onChange={(e) => setMapeo({ ...mapeo, [c]: e.target.value === "atributo" ? `atributo:${c.trim().toLowerCase().replace(/\s+/g, "_")}` : e.target.value })}>
                              {DESTINOS.map((d) => <option key={d} value={d}>{d === "ignorar" ? "— ignorar —" : d}</option>)}
                              <option value="atributo">atributo…</option>
                            </select>
                            {esAtributo && (
                              <input type="text" style={{ marginTop: 4 }} value={v.slice(9)} onChange={(e) => setMapeo({ ...mapeo, [c]: `atributo:${e.target.value}` })} aria-label="Nombre del atributo" />
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {previa.muestra.map((fila, i) => (
                      <tr key={i}>{previa.columnas.map((c) => <td key={c} className="trunc" style={{ maxWidth: 200 }}>{fila[c]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rejilla c2">
                <Campo etiqueta="Etiquetas para todos"><ListaTextos valor={etiquetas} onCambio={setEtiquetas} /></Campo>
                <Campo etiqueta="Inscribir en campaña (opcional)">
                  <select value={sec ?? ""} onChange={(e) => setSec(Number(e.target.value) || null)}>
                    <option value="">No inscribir</option>
                    {secuencias?.map((s) => <option key={s.id} value={s.id}>{s.nombre} ({s.estado})</option>)}
                  </select>
                </Campo>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ───────── Ficha ─────────

function Ficha({ id, onCerrar, onCambio }: { id: number; onCerrar: () => void; onCambio: () => void }) {
  const avisar = useAvisos();
  const { puede } = useSesion();
  const { datos: c, recargar, error } = useCarga(() => api.get<Detalle>(`/api/contactos/${id}`), [id]);
  const [editar, setEditar] = useState(false);
  const baja = async (canales: string[]) => {
    if (!confirm(`¿Marcar baja de ${canales.join(", ")}? El contacto dejará de recibir mensajes por esos canales y saldrá de las campañas.`)) return;
    try {
      await api.post(`/api/contactos/${id}/baja`, { canales });
      avisar("Baja registrada");
      recargar();
      onCambio();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const reactivar = async (campo: "opt_out_whatsapp" | "opt_out_llamadas" | "opt_out_correo") => {
    try {
      await api.patch(`/api/contactos/${id}`, { [campo]: false });
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const borrar = async () => {
    if (!confirm("¿Borrar el contacto y todo su historial? No se puede deshacer.")) return;
    try {
      await api.del(`/api/contactos/${id}`);
      avisar("Contacto borrado");
      onCambio();
      onCerrar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  type Evento = { fecha: string; icono: string; texto: React.ReactNode; enlace?: string };
  const eventos: Evento[] = c ? [
    ...c.conversaciones.map((x) => ({ fecha: x.creado, icono: CANALES[x.canal]?.icono ?? "chat", enlace: `/inbox/${x.id}`,
      texto: <>{CANALES[x.canal]?.texto} · {x.estado}{x.exito !== null && <> · <Insignia tono={x.exito ? "ok" : "error"}>{x.exito ? "éxito" : "sin éxito"}</Insignia></>}{x.resumen && <div className="chico tenue">{x.resumen}</div>}</> })),
    ...c.llamadas.map((l) => ({ fecha: l.creado, icono: "call", enlace: l.conversacion_id ? `/inbox/${l.conversacion_id}` : undefined,
      texto: <>Llamada {l.direccion} · <Insignia tono={RESULTADOS_LLAMADA[l.resultado]?.tono}>{RESULTADOS_LLAMADA[l.resultado]?.texto}</Insignia> · {fmt.duracion(l.duracion_s)}</> })),
    ...c.inscripciones.map((i) => ({ fecha: i.creado, icono: "campaign", enlace: `/secuencias/${i.secuencia_id}`,
      texto: <>Campaña «{i.secuencia}» · paso {i.paso + 1} · <Insignia>{i.estado}</Insignia></> })),
    ...c.citas.map((x) => ({ fecha: x.inicio, icono: "event", texto: <>Cita {fmt.fecha(x.inicio)} ({x.duracion_min} min) · {x.estado}{x.notas && <div className="chico tenue">{x.notas}</div>}</> })),
  ].sort((a, b) => b.fecha.localeCompare(a.fecha)) : [];

  return (
    <Cajon titulo={c?.nombre || c?.telefono || "Contacto"} onCerrar={onCerrar}
      pie={c && puede("operador") ? (
        <>
          {puede("admin") && <Boton variante="peligro" icono="delete" onClick={borrar}>Borrar</Boton>}
          <Boton variante="contorno" icono="block" onClick={() => baja(["whatsapp", "llamadas", "correo"])}>Baja total</Boton>
          <Boton variante="primario" icono="edit" onClick={() => setEditar(true)}>Editar</Boton>
        </>
      ) : undefined}>
      {error && <Banner tono="error">{error}</Banner>}
      {!c ? <Cargando /> : (
        <>
          <div className="rejilla c2">
            <div className="pila c">
              <span className="chico tenue">Teléfono</span><b>{c.telefono ?? "—"}</b>
              <span className="chico tenue">Correo</span><b className="trunc">{c.email ?? "—"}</b>
            </div>
            <div className="pila c">
              <span className="chico tenue">Empresa</span><b>{c.empresa || "—"}</b>
              <span className="chico tenue">Etapa · zona</span><span><Insignia tono="primaria">{c.etapa}</Insignia> <span className="chico tenue">{c.zona_horaria ?? ""}</span></span>
            </div>
          </div>
          {c.etiquetas.length > 0 && <div className="fila" style={{ gap: 4 }}>{c.etiquetas.map((e) => <Insignia key={e}>{e}</Insignia>)}</div>}
          <div className="pila c">
            <b>Canales</b>
            {([["opt_out_whatsapp", "WhatsApp", "whatsapp"], ["opt_out_llamadas", "Llamadas", "llamadas"], ["opt_out_correo", "Correo", "correo"]] as const).map(([campo, texto, canal]) => (
              <div key={campo} className="fila e">
                <span>{texto}</span>
                {c[campo] ? (
                  <span className="fila"><Insignia tono="error">Dado de baja</Insignia>{puede("operador") && <Boton chico variante="texto" onClick={() => reactivar(campo)}>Reactivar</Boton>}</span>
                ) : (
                  <span className="fila"><Insignia tono="ok">Permitido</Insignia>{puede("operador") && <Boton chico variante="texto" onClick={() => baja([canal])}>Dar de baja</Boton>}</span>
                )}
              </div>
            ))}
          </div>
          {Object.keys(c.atributos).length > 0 && (
            <div className="pila c">
              <b>Atributos</b>
              {Object.entries(c.atributos).map(([k, v]) => <div key={k} className="fila e"><span className="tenue">{k}</span><span>{v}</span></div>)}
            </div>
          )}
          {Object.keys(c.datos_ia).length > 0 && (
            <div className="pila c">
              <b><Icono n="smart_toy" /> Datos capturados por la IA</b>
              {Object.entries(c.datos_ia).map(([k, v]) => <div key={k} className="fila e"><span className="tenue">{k}</span><span>{String(v)}</span></div>)}
            </div>
          )}
          <div className="pila c">
            <b>Línea de tiempo</b>
            {eventos.length === 0 && <span className="tenue chico">Sin actividad todavía.</span>}
            {eventos.map((e, i) => (
              <div key={i} className="fila" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <Icono n={e.icono} />
                <div className="crece">
                  <div>{e.enlace ? <Link to={e.enlace}>{e.texto}</Link> : e.texto}</div>
                  <div className="chico tenue">{fmt.fecha(e.fecha)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {editar && c && <FormContacto inicial={c} onCerrar={() => setEditar(false)} onGuardado={() => { setEditar(false); recargar(); onCambio(); }} />}
    </Cajon>
  );
}

// ───────── Página ─────────

export default function Contactos() {
  const { id } = useParams();
  const navegar = useNavigate();
  const { puede } = useSesion();
  const [q, setQ] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [etapa, setEtapa] = useState("");
  const [etiqueta, setEtiqueta] = useState("");
  const [pagina, setPagina] = useState(1);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [modal, setModal] = useState<"" | "nuevo" | "importar" | "inscribir">("");
  useEffect(() => {
    const t = setTimeout(() => { setBusqueda(q); setPagina(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const { datos, cargando, error, recargar } = useCarga(
    () => api.get<Listado>(`/api/contactos${qs({ q: busqueda, etapa, etiqueta, pagina, por_pagina: POR_PAGINA })}`),
    [busqueda, etapa, etiqueta, pagina],
  );
  const etiquetas = datos?.etiquetas ?? [];
  const paginas = datos ? Math.max(1, Math.ceil(datos.total / POR_PAGINA)) : 1;
  const todos = !!datos?.contactos.length && datos.contactos.every((c) => sel.has(c.id));
  const alternar = (cid: number) => setSel((s) => { const n = new Set(s); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });

  return (
    <div className="pagina">
      <Encabezado titulo="Contactos" descripcion={datos ? `${fmt.numero(datos.total)} contactos` : undefined}
        acciones={puede("operador") && (
          <>
            {sel.size > 0 && <Boton variante="secundario" icono="campaign" onClick={() => setModal("inscribir")}>Inscribir {sel.size} en campaña</Boton>}
            <Boton variante="contorno" icono="upload_file" onClick={() => setModal("importar")}>Importar</Boton>
            <Boton variante="primario" icono="person_add" onClick={() => setModal("nuevo")}>Nuevo contacto</Boton>
          </>
        )} />
      <div className="fila" style={{ marginBottom: "var(--gap-16)" }}>
        <input type="search" style={{ maxWidth: 320 }} placeholder="Buscar nombre, teléfono, correo, empresa" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ width: "auto" }} value={etapa} onChange={(e) => { setEtapa(e.target.value); setPagina(1); }} aria-label="Etapa">
          <option value="">Todas las etapas</option>
          {datos?.etapas.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <select style={{ width: "auto" }} value={etiqueta} onChange={(e) => { setEtiqueta(e.target.value); setPagina(1); }} aria-label="Etiqueta">
          <option value="">Todas las etiquetas</option>
          {[...new Set([...etiquetas, ...(etiqueta ? [etiqueta] : [])])].map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      {error && <Banner tono="error">{error}</Banner>}
      {!datos && cargando && <Cargando />}
      {datos && datos.contactos.length === 0 ? (
        <Vacio icono="contacts" titulo="Sin contactos" accion={puede("operador") && <Boton variante="primario" icono="upload_file" onClick={() => setModal("importar")}>Importar CSV o Excel</Boton>}>
          Los contactos también se crean solos cuando escriben por WhatsApp, el widget o llaman.
        </Vacio>
      ) : datos && (
        <>
          <div className="tabla-env">
            <table className="tabla">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={todos} aria-label="Seleccionar todos"
                      onChange={() => setSel(todos ? new Set() : new Set(datos.contactos.map((c) => c.id)))} />
                  </th>
                  <th>Nombre</th><th>Teléfono</th><th>Correo</th><th>Empresa</th><th>Etapa</th><th>Etiquetas</th><th>Último contacto</th>
                </tr>
              </thead>
              <tbody>
                {datos.contactos.map((c) => (
                  <tr key={c.id} className="clic" onClick={() => navegar(`/contactos/${c.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(c.id)} onChange={() => alternar(c.id)} aria-label={`Seleccionar ${c.nombre}`} />
                    </td>
                    <td>{c.nombre ? <b>{c.nombre}</b> : <span className="tenue">{c.etiquetas.includes("widget") ? "Visitante web" : "Sin nombre"}</span>}{(c.opt_out_whatsapp || c.opt_out_llamadas) && <> <Insignia tono="error">baja</Insignia></>}</td>
                    <td className="mono">{c.telefono ?? "—"}</td>
                    <td className="trunc" style={{ maxWidth: 220 }}>{c.email ?? "—"}</td>
                    <td className="trunc" style={{ maxWidth: 180 }}>{c.empresa || "—"}</td>
                    <td><Insignia>{c.etapa}</Insignia></td>
                    <td><div className="fila" style={{ gap: 4 }}>{c.etiquetas.slice(0, 3).map((e) => <Insignia key={e}>{e}</Insignia>)}{c.etiquetas.length > 3 && <span className="chico tenue">+{c.etiquetas.length - 3}</span>}</div></td>
                    <td className="tenue">{fmt.relativa(c.ultimo_contacto_en)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {paginas > 1 && (
            <div className="fila e" style={{ marginTop: "var(--gap-12)" }}>
              <span className="tenue chico">Página {pagina} de {paginas}</span>
              <div className="acciones">
                <Boton chico icono="chevron_left" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>Anterior</Boton>
                <Boton chico disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)}>Siguiente <span className="ms">chevron_right</span></Boton>
              </div>
            </div>
          )}
        </>
      )}
      {sel.size > 0 && (
        <div className="fila" style={{ marginTop: 8 }}>
          <span className="chico tenue">{sel.size} seleccionados</span>
          <Boton chico variante="texto" onClick={() => setSel(new Set())}>Limpiar selección</Boton>
        </div>
      )}
      {id && <Ficha id={Number(id)} onCerrar={() => navegar("/contactos")} onCambio={recargar} />}
      {modal === "nuevo" && <FormContacto onCerrar={() => setModal("")} onGuardado={(c) => { setModal(""); recargar(); navegar(`/contactos/${c.id}`); }} />}
      {modal === "importar" && <Importar onCerrar={() => setModal("")} onListo={recargar} />}
      {modal === "inscribir" && <Inscribir ids={[...sel]} onCerrar={() => { setModal(""); setSel(new Set()); }} />}
    </div>
  );
}
