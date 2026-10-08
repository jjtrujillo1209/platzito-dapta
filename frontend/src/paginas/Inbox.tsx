// Inbox omnicanal: lista de conversaciones, hilo y panel de contexto con toma humana.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, qs } from "../api";
import Hilo from "../componentes/inbox-hilo";
import {
  Banner, Boton, CANALES, Campo, Cargando, Icono, Insignia, Modal, Vacio, fmt, useAvisos, useCarga, useIntervalo,
} from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Conversacion, Mensaje, Plantilla } from "../tipos";
import "./inbox-estilos.css";

const ESTADOS: { id: string; texto: string }[] = [
  { id: "abierta,esperando_humano", texto: "Activas" },
  { id: "esperando_humano", texto: "Esperan humano" },
  { id: "abierta", texto: "Abiertas" },
  { id: "cerrada", texto: "Cerradas" },
  { id: "", texto: "Todas" },
];

function iniciales(c: Conversacion) {
  const n = c.contacto?.nombre || c.contacto?.telefono || "?";
  return n.replace(/[^\p{L}\d ]/gu, "").split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
}

function nombreContacto(c: Conversacion) {
  return c.contacto?.nombre || c.contacto?.telefono || c.contacto?.email || `Visitante #${c.id}`;
}

function Lista({ actual }: { actual?: number }) {
  const [estado, setEstado] = useState("abierta,esperando_humano");
  const [canal, setCanal] = useState("");
  const [asignado, setAsignado] = useState("");
  const [q, setQ] = useState("");
  const [busqueda, setBusqueda] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { datos, recargar, error } = useCarga(
    () => api.get<{ total: number; conteo: Record<string, number>; conversaciones: Conversacion[] }>(
      `/api/conversaciones${qs({ estado, canal, asignado, q: busqueda, por_pagina: 100 })}`),
    [estado, canal, asignado, busqueda],
  );
  useIntervalo(recargar, 4000);
  const conteo = datos?.conteo ?? {};
  return (
    <div className="inbox-col">
      <div className="inbox-cab">
        <div className="fila e">
          <h1>Inbox</h1>
          <span className="chico tenue">
            {conteo.esperando_humano ? <Insignia tono="aviso">{conteo.esperando_humano} esperan humano</Insignia> : null}
          </span>
        </div>
        <input type="search" placeholder="Buscar por nombre, teléfono o correo" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="inbox-filtros">
          <select value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado">
            {ESTADOS.map((e) => {
              const n = e.id ? e.id.split(",").reduce((s, k) => s + (conteo[k] ?? 0), 0) : Object.values(conteo).reduce((a, b) => a + b, 0);
              return <option key={e.id} value={e.id}>{e.texto} ({n})</option>;
            })}
          </select>
          <select value={canal} onChange={(e) => setCanal(e.target.value)} aria-label="Canal">
            <option value="">Todos los canales</option>
            {["whatsapp", "widget", "voz", "correo"].map((c) => <option key={c} value={c}>{CANALES[c].texto}</option>)}
          </select>
          <select value={asignado} onChange={(e) => setAsignado(e.target.value)} aria-label="Asignación">
            <option value="">Cualquiera</option>
            <option value="yo">Asignadas a mí</option>
            <option value="nadie">Sin asignar</option>
            <option value="humano">Con humano (IA en pausa)</option>
          </select>
        </div>
      </div>
      <div className="inbox-lista">
        {error && <div style={{ padding: 16 }}><Banner tono="error">{error}</Banner></div>}
        {!datos && !error && <Cargando />}
        {datos && datos.conversaciones.length === 0 && <Vacio icono="forum" titulo="Sin conversaciones">Aquí llegan los mensajes de WhatsApp, del widget web y las llamadas.</Vacio>}
        {datos?.conversaciones.map((c) => (
          <Link key={c.id} to={`/inbox/${c.id}`} className={`inbox-item ${c.id === actual ? "activo" : ""}`}>
            <div className="inbox-avatar">
              {iniciales(c)}
              <Icono n={CANALES[c.canal]?.icono ?? "chat"} />
            </div>
            <div className="crece">
              <div className="fila e" style={{ gap: 4, flexWrap: "nowrap" }}>
                <b className="trunc">{nombreContacto(c)}</b>
                <span className="chico tenue" style={{ flex: "none" }}>{fmt.relativa(c.ultimo_mensaje_en)}</span>
              </div>
              <div className="fila e" style={{ gap: 4, flexWrap: "nowrap" }}>
                <span className="chico tenue trunc">
                  {c.ultimo_mensaje ? `${c.ultimo_mensaje.autor === "contacto" ? "" : c.ultimo_mensaje.autor === "ia" ? "IA: " : "Tú: "}${c.ultimo_mensaje.contenido}` : "—"}
                </span>
                <span className="fila" style={{ gap: 4, flex: "none", flexWrap: "nowrap" }}>
                  {c.estado === "esperando_humano" && <Icono n="support_agent" titulo="Espera humano" />}
                  {!c.ia_activa && c.estado !== "esperando_humano" && <Icono n="person" titulo="Atiende una persona" />}
                  {c.no_leidos > 0 && <span className="inbox-noleidos">{c.no_leidos}</span>}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function EnviarPlantilla({ conv, onCerrar, onEnviada }: { conv: Conversacion; onCerrar: () => void; onEnviada: () => void }) {
  const avisar = useAvisos();
  const { datos } = useCarga(() => api.get<Plantilla[]>(`/api/plantillas${qs({ linea_id: conv.linea_id })}`), [conv.linea_id]);
  const aprobadas = (datos ?? []).filter((p) => p.estado === "APPROVED");
  const [id, setId] = useState<number | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const p = aprobadas.find((x) => x.id === id);
  useEffect(() => {
    if (p) setVars(Array.from({ length: p.n_variables }, (_, i) => (i === 0 ? conv.contacto?.nombre?.split(" ")[0] ?? "" : "")));
  }, [p, conv.contacto]);
  const vista = p ? vars.reduce((t, v, i) => t.split(`{{${i + 1}}}`).join(v || `{{${i + 1}}}`), p.cuerpo) : "";
  const enviar = async () => {
    if (!p) return;
    setEnviando(true);
    try {
      await api.post(`/api/conversaciones/${conv.id}/plantilla`, { plantilla_id: p.id, variables: vars });
      avisar("Plantilla enviada");
      onEnviada();
      onCerrar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Modal titulo="Enviar plantilla" onCerrar={onCerrar}
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" icono="send" disabled={!p} cargando={enviando} onClick={enviar}>Enviar</Boton></>}>
      {datos && aprobadas.length === 0 && <Banner tono="aviso">Esta línea no tiene plantillas aprobadas. Créalas en Canales → Plantillas.</Banner>}
      <Campo etiqueta="Plantilla">
        <select value={id ?? ""} onChange={(e) => setId(Number(e.target.value) || null)}>
          <option value="">Elige una plantilla…</option>
          {aprobadas.map((x) => <option key={x.id} value={x.id}>{x.nombre} · {x.idioma} · {x.categoria}</option>)}
        </select>
      </Campo>
      {p && vars.map((v, i) => (
        <Campo key={i} etiqueta={`Variable {{${i + 1}}}`}>
          <input type="text" value={v} onChange={(e) => setVars(vars.map((x, j) => (j === i ? e.target.value : x)))} />
        </Campo>
      ))}
      {p && <div className="burbuja saliente" style={{ maxWidth: "100%" }}>{vista}</div>}
    </Modal>
  );
}

function Compositor({ conv, onEnviado }: { conv: Conversacion; onEnviado: () => void }) {
  const avisar = useAvisos();
  const [texto, setTexto] = useState("");
  const [nota, setNota] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [plantilla, setPlantilla] = useState(false);
  if (conv.canal === "voz") return <div className="inbox-compositor tenue chico">Las llamadas no admiten respuestas escritas.</div>;
  const ventanaCerrada = conv.canal === "whatsapp" && !conv.ventana_24h?.abierta;
  const enviar = async () => {
    const t = texto.trim();
    if (!t) return;
    setEnviando(true);
    try {
      await api.post(`/api/conversaciones/${conv.id}/${nota ? "notas" : "mensajes"}`, { texto: t });
      setTexto("");
      onEnviado();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  return (
    <div className={`inbox-compositor ${nota ? "nota" : ""}`}>
      {!nota && conv.ia_activa && (
        <span className="chico tenue"><Icono n="info" /> Si respondes tú, la IA se pausa en esta conversación hasta que la devuelvas.</span>
      )}
      {!nota && ventanaCerrada ? (
        <Banner tono="aviso" icono="schedule">
          La ventana de 24 h de WhatsApp está cerrada: solo puedes enviar una plantilla aprobada.{" "}
          <Boton chico variante="primario" icono="description" onClick={() => setPlantilla(true)}>Enviar plantilla</Boton>
        </Banner>
      ) : (
        <textarea
          value={texto}
          placeholder={nota ? "Nota interna (no la ve el contacto)…" : "Escribe una respuesta… (Enter envía, Shift+Enter salto de línea)"}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
        />
      )}
      <div className="fila e">
        <div className="fila">
          <Boton chico variante={nota ? "secundario" : "contorno"} icono="sticky_note_2" onClick={() => setNota(!nota)}>
            {nota ? "Modo nota" : "Nota interna"}
          </Boton>
          {conv.canal === "whatsapp" && !ventanaCerrada && (
            <Boton chico variante="contorno" icono="description" onClick={() => setPlantilla(true)}>Plantilla</Boton>
          )}
        </div>
        {(nota || !ventanaCerrada) && (
          <Boton variante="primario" icono="send" cargando={enviando} disabled={!texto.trim()} onClick={enviar}>
            {nota ? "Guardar nota" : "Enviar"}
          </Boton>
        )}
      </div>
      {plantilla && <EnviarPlantilla conv={conv} onCerrar={() => setPlantilla(false)} onEnviada={onEnviado} />}
    </div>
  );
}

function Cuenta({ hasta }: { hasta: string }) {
  const [, setT] = useState(0);
  useIntervalo(() => setT((x) => x + 1), 30000);
  const ms = new Date(hasta).getTime() - Date.now();
  if (ms <= 0) return <Insignia tono="error">Cerrada</Insignia>;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return <Insignia tono={h < 2 ? "aviso" : "ok"}>Cierra en {h} h {m} min</Insignia>;
}

function Panel({ conv, onCambio }: { conv: Conversacion; onCambio: () => void }) {
  const avisar = useAvisos();
  const { puede } = useSesion();
  const [ocupado, setOcupado] = useState("");
  const accion = async (clave: string, ruta: string, cuerpo: unknown = {}, ok?: string) => {
    setOcupado(clave);
    try {
      await api.post(`/api/conversaciones/${conv.id}/${ruta}`, cuerpo);
      if (ok) avisar(ok);
      onCambio();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setOcupado("");
    }
  };
  const c = conv.contacto;
  const operador = puede("operador");
  const { datos: miembros } = useCarga(() => api.get<{ miembros: { usuario_id: number; nombre: string }[] }>("/api/miembros"), []);
  return (
    <div className="inbox-col">
      <div className="inbox-panel">
        <div className="tarjeta pila c">
          <div className="fila e">
            <b className="trunc">{nombreContacto(conv)}</b>
            {c && <Link to={`/contactos/${c.id}`} className="chico">Ver ficha</Link>}
          </div>
          {c?.empresa && <div className="chico tenue">{c.empresa}</div>}
          {c?.telefono && <div className="inbox-dato"><span>Teléfono</span><span>{c.telefono}</span></div>}
          {c?.email && <div className="inbox-dato"><span>Correo</span><span className="trunc">{c.email}</span></div>}
          {c && <div className="inbox-dato"><span>Etapa</span><Insignia>{c.etapa}</Insignia></div>}
          {c && c.etiquetas.length > 0 && <div className="fila" style={{ gap: 4 }}>{c.etiquetas.map((e) => <Insignia key={e}>{e}</Insignia>)}</div>}
        </div>

        <div className="pila c">
          <div className="inbox-dato"><span>Canal</span><span><Icono n={CANALES[conv.canal]?.icono ?? "chat"} /> {CANALES[conv.canal]?.texto}</span></div>
          <div className="inbox-dato"><span>Estado</span>
            <Insignia tono={conv.estado === "esperando_humano" ? "aviso" : conv.estado === "cerrada" ? "" : "ok"}>
              {conv.estado === "esperando_humano" ? "Espera humano" : conv.estado}
            </Insignia>
          </div>
          {conv.ventana_24h && <div className="inbox-dato"><span>Ventana 24 h</span><Cuenta hasta={conv.ventana_24h.cierra_en} /></div>}
          <div className="inbox-dato"><span>Costo IA</span><span>{fmt.usd(conv.costo_usd)} · {fmt.numero(conv.tokens)} tokens</span></div>
        </div>

        {conv.motivo_escalado && <Banner tono="aviso" icono="support_agent">Escalado: {conv.motivo_escalado}</Banner>}

        {operador && (
          <div className="pila c">
            <div className="fila e">
              <span><Icono n="smart_toy" /> IA {conv.ia_activa ? "activa" : "en pausa"}</span>
              <Boton chico variante={conv.ia_activa ? "contorno" : "primario"} cargando={ocupado === "ia"}
                onClick={() => accion("ia", "ia", { activa: !conv.ia_activa }, conv.ia_activa ? "IA en pausa" : "IA activada")}>
                {conv.ia_activa ? "Pausar IA" : "Activar IA"}
              </Boton>
            </div>
            {conv.asignado_a && (
              <div className="inbox-dato"><span>Asignada a</span><span className="trunc">{conv.asignado_nombre ?? "Compañero"}</span></div>
            )}
            {conv.asignado_a ? (
              <Boton variante="secundario" icono="smart_toy" cargando={ocupado === "asig"} onClick={() => accion("asig", "asignar", { usuario_id: null }, "Devuelta a la IA")}>
                Devolver a la IA
              </Boton>
            ) : (
              <Boton variante="secundario" icono="person_add" cargando={ocupado === "asig"} onClick={() => accion("asig", "asignar", { usuario_id: "yo" }, "Conversación asignada a ti")}>
                Asignarme (pausa la IA)
              </Boton>
            )}
            {(miembros?.miembros.length ?? 0) > 1 && (
              <Campo etiqueta="Asignar a un compañero">
                <select value={conv.asignado_a ?? ""} disabled={ocupado === "asig"} onChange={(e) => {
                  const m = miembros?.miembros.find((x) => x.usuario_id === Number(e.target.value));
                  if (m) accion("asig", "asignar", { usuario_id: m.usuario_id }, `Asignada a ${m.nombre}`);
                }}>
                  <option value="" disabled>Elige a alguien…</option>
                  {miembros?.miembros.map((m) => <option key={m.usuario_id} value={m.usuario_id}>{m.nombre}</option>)}
                </select>
              </Campo>
            )}
            {conv.estado === "cerrada" ? (
              <Boton variante="contorno" icono="lock_open" cargando={ocupado === "cer"} onClick={() => accion("cer", "reabrir")}>Reabrir</Boton>
            ) : (
              <Boton variante="contorno" icono="task_alt" cargando={ocupado === "cer"} onClick={() => accion("cer", "cerrar", {}, "Conversación cerrada y analizada")}>Cerrar y analizar</Boton>
            )}
          </div>
        )}

        <div className="tarjeta pila c">
          <div className="fila e">
            <b><Icono n="insights" /> Análisis</b>
            {puede("editor") && (
              <Boton chico variante="texto" icono="refresh" cargando={ocupado === "an"} onClick={() => accion("an", "analizar", {}, "Análisis actualizado")}>Analizar</Boton>
            )}
          </div>
          {conv.resumen ? <p style={{ margin: 0 }}>{conv.resumen}</p> : <span className="chico tenue">Se analiza al cerrar la conversación.</span>}
          {conv.exito !== null && (
            <div className="inbox-dato"><span>Objetivo</span><Insignia tono={conv.exito ? "ok" : "error"}>{conv.exito ? "Logrado" : "No logrado"}</Insignia></div>
          )}
          {conv.sentimiento && <div className="inbox-dato"><span>Sentimiento</span><span>{conv.sentimiento}</span></div>}
          {Object.entries(conv.analisis ?? {}).map(([k, v]) => (
            <div key={k} className="inbox-dato"><span>{k}</span><span style={{ textAlign: "right" }}>{String(v)}</span></div>
          ))}
        </div>
        {c && Object.keys(c.datos_ia ?? {}).length > 0 && (
          <div className="tarjeta pila c">
            <b><Icono n="database" /> Datos guardados por la IA</b>
            {Object.entries(c.datos_ia).map(([k, v]) => (
              <div key={k} className="inbox-dato"><span>{k}</span><span>{String(v)}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HiloConversacion({ id }: { id: number }) {
  const avisar = useAvisos();
  const navegar = useNavigate();
  const { datos: conv, recargar, error, setDatos } = useCarga(() => api.get<Conversacion>(`/api/conversaciones/${id}`), [id]);
  useIntervalo(recargar, 3000);
  const fondo = useRef<HTMLDivElement>(null);
  const nMensajes = conv?.mensajes?.length ?? 0;
  useEffect(() => {
    fondo.current?.scrollTo({ top: fondo.current.scrollHeight });
  }, [nMensajes, id]);
  const calificar = async (m: Mensaje, valor: number) => {
    try {
      await api.post(`/api/conversaciones/mensajes/${m.id}/calificar`, { valor });
      setDatos((c) => c && { ...c, mensajes: c.mensajes?.map((x) => (x.id === m.id ? { ...x, calificacion: valor || null } : x)) });
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  if (error) return <div className="inbox-col"><div style={{ padding: 16 }}><Banner tono="error">{error}</Banner><Boton variante="texto" onClick={() => navegar("/inbox")}>Volver</Boton></div></div>;
  if (!conv) return <div className="inbox-col"><Cargando /></div>;
  return (
    <>
      <div className="inbox-col">
        <div className="inbox-cab" style={{ flexDirection: "row", alignItems: "center" }}>
          <div className="inbox-avatar">{iniciales(conv)}<Icono n={CANALES[conv.canal]?.icono ?? "chat"} /></div>
          <div className="crece">
            <b className="trunc">{nombreContacto(conv)}</b>
            <div className="chico tenue">{CANALES[conv.canal]?.texto} · iniciada {fmt.fecha(conv.creado)}</div>
          </div>
          {!conv.ia_activa && <Insignia tono="aviso"><Icono n="person" /> Humano</Insignia>}
        </div>
        <div className="inbox-hilo" ref={fondo}>
          {conv.mensajes && conv.mensajes.length > 0 ? <Hilo mensajes={conv.mensajes} onCalificar={calificar} /> : <Vacio icono="chat" titulo="Sin mensajes" />}
        </div>
        <Compositor conv={conv} onEnviado={recargar} />
      </div>
      <Panel conv={conv} onCambio={recargar} />
    </>
  );
}

export default function Inbox() {
  const { id } = useParams();
  const actual = useMemo(() => (id ? Number(id) : undefined), [id]);
  return (
    <div className="pagina completa">
      <div className="inbox">
        <Lista actual={actual} />
        {actual ? (
          <HiloConversacion key={actual} id={actual} />
        ) : (
          <div className="inbox-col" style={{ gridColumn: "span 2" }}>
            <Vacio icono="forum" titulo="Elige una conversación">
              La IA responde sola. Cuando un contacto pide una persona, la conversación queda en «Esperan humano». Asígnatela
              para tomar el control; al devolverla, la IA retoma.
            </Vacio>
          </div>
        )}
      </div>
    </div>
  );
}
