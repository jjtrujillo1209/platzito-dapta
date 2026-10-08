// Pestañas Probar (playground sobre el borrador) y Simulador (personas vs. agente con rúbrica).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Mensaje, Simulacion } from "../tipos";
import { Ayuda, Num, type PropsPestana } from "./agente-comun";
import {
  Banner, Boton, Cajon, Campo, Check, Icono, Insignia, Modal, Tarjeta, Vacio, fmt, useAvisos, useCarga, useIntervalo,
} from "./ui";

// ───────── Mensajes con herramientas ─────────

export function BurbujaMensaje({ m }: { m: Mensaje }) {
  if (m.tipo === "nota" || m.autor === "sistema") return <div className="burbuja nota">{m.contenido}</div>;
  if (m.tipo === "herramienta") {
    const llamadas = (m.datos.llamadas ?? []) as { nombre: string; args: unknown }[];
    const resultados = (m.datos.resultados ?? []) as { nombre: string; resultado: string }[];
    return (
      <>
        {m.contenido && <div className="burbuja saliente">{m.contenido}</div>}
        {llamadas.map((ll, i) => (
          <details key={i} className="herramienta-chip">
            <summary><Icono n="build" /> {ll.nombre}({Object.keys((ll.args ?? {}) as object).join(", ")})</summary>
            <pre className="chico" style={{ marginTop: 6 }}>{JSON.stringify(ll.args, null, 1)}</pre>
            <pre className="chico tenue" style={{ marginTop: 6, maxHeight: 200, overflow: "auto" }}>{resultados[i]?.resultado}</pre>
          </details>
        ))}
      </>
    );
  }
  const saliente = m.direccion === "saliente";
  const fuentes = (m.datos?.fuentes ?? []) as { titulo: string; url: string }[];
  return (
    <div className={`burbuja ${saliente ? "saliente" : "entrante"} ${m.autor === "humano" ? "humano" : ""}`}>
      {m.contenido}
      {fuentes.length > 0 && (
        <div className="meta" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          {fuentes.filter((f) => f.url).slice(0, 3).map((f, i) => <a key={i} href={f.url} target="_blank" rel="noreferrer">{f.titulo || f.url}</a>)}
        </div>
      )}
    </div>
  );
}

export function PestanaProbar({ agente, editable }: PropsPestana) {
  const avisar = useAvisos();
  const [conv, setConv] = useState<number | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [texto, setTexto] = useState("");
  const [canal, setCanal] = useState<"whatsapp" | "widget" | "voz">("whatsapp");
  const [enviando, setEnviando] = useState(false);
  const [info, setInfo] = useState({ costo: 0, tokens: 0, escalado: false });
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fin.current?.scrollIntoView({ behavior: "smooth" }); // en Chromium reciente devuelve una Promise: no retornarla
  }, [mensajes, enviando]);

  const enviar = async () => {
    const t = texto.trim();
    if (!t) return;
    setTexto("");
    setEnviando(true);
    setMensajes((ms) => [...ms, { id: -Date.now(), conversacion_id: conv ?? 0, direccion: "entrante", autor: "contacto", tipo: "texto",
      contenido: t, datos: {}, estado_entrega: "", error: "", calificacion: null, autor_usuario_id: null, creado: new Date().toISOString() }]);
    try {
      const r = await api.post<{ conversacion_id: number; mensajes: Mensaje[]; costo_usd: number; tokens: number; escalado: boolean }>(
        `/api/agentes/${agente.id}/playground`, { texto: t, conversacion_id: conv, canal_simulado: canal });
      setConv(r.conversacion_id);
      setMensajes(r.mensajes);
      setInfo({ costo: r.costo_usd, tokens: r.tokens, escalado: r.escalado });
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  const reiniciar = () => { setConv(null); setMensajes([]); setInfo({ costo: 0, tokens: 0, escalado: false }); };

  return (
    <Tarjeta titulo="Probar el borrador" icono="science" acciones={<>
      <select value={canal} disabled={conv !== null} onChange={(e) => setCanal(e.target.value as typeof canal)} style={{ width: 180 }} title="Estilo y herramientas del canal">
        <option value="whatsapp">Como WhatsApp</option>
        <option value="widget">Como chat web</option>
        <option value="voz">Como llamada (texto)</option>
      </select>
      <Boton icono="restart_alt" onClick={reiniciar}>Reiniciar</Boton>
    </>}>
      <Ayuda>Conversa con el borrador sin publicarlo. Las herramientas con efectos externos (agendar, enviar plantillas) se simulan. Guarda los cambios antes de probar.</Ayuda>
      {info.escalado && <div style={{ marginTop: 8 }}><Banner tono="aviso" icono="support_agent">La conversación se escaló a un humano: la IA dejó de responder. Reinicia para seguir probando.</Banner></div>}
      <div className="chat tarjeta plana" style={{ height: 460, marginTop: "var(--gap-12)" }}>
        {mensajes.length === 0 && <span className="tenue chico">Escribe como si fueras el contacto.</span>}
        {mensajes.map((m) => <BurbujaMensaje key={m.id} m={m} />)}
        {enviando && <div className="burbuja saliente tenue"><Icono n="more_horiz" /></div>}
        <div ref={fin} />
      </div>
      <div className="fila" style={{ marginTop: "var(--gap-12)", flexWrap: "nowrap" }}>
        <input type="text" value={texto} disabled={!editable || info.escalado} placeholder="Escribe un mensaje…" onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !enviando && enviar()} />
        <Boton variante="primario" icono="send" disabled={!texto.trim() || !editable} cargando={enviando} onClick={enviar}>Enviar</Boton>
      </div>
      <div className="chico tenue" style={{ marginTop: 8 }}>{fmt.numero(info.tokens)} tokens · {fmt.usd(info.costo)}</div>
    </Tarjeta>
  );
}

// ───────── Simulador ─────────

type Escenario = NonNullable<Simulacion["escenarios"]>[number];

function NuevaSimulacion({ agenteId, onCerrar, onCreada }: { agenteId: number; onCerrar: () => void; onCreada: (s: Simulacion) => void }) {
  const avisar = useAvisos();
  const lista = useCarga(() => api.get<{ comportamientos: string[]; rubrica: string[] }>("/api/simulaciones/comportamientos/lista"));
  const [nombre, setNombre] = useState("Simulación");
  const [n, setN] = useState(5);
  const [maxTurnos, setMaxTurnos] = useState(8);
  const [borrador, setBorrador] = useState(true);
  const [propios, setPropios] = useState(false);
  const [escenarios, setEscenarios] = useState<Escenario[]>([]);
  const [rubrica, setRubrica] = useState("");
  const [cargando, setCargando] = useState(false);
  const comps = lista.datos?.comportamientos ?? [];
  const crear = async () => {
    setCargando(true);
    try {
      const s = await api.post<Simulacion>(`/api/agentes/${agenteId}/simulaciones`, {
        nombre, n_escenarios: n, max_turnos: maxTurnos, usar_borrador: borrador,
        escenarios: propios ? escenarios : [],
        rubrica: rubrica.split("\n").map((x) => x.trim()).filter(Boolean),
      });
      onCreada(s);
    } catch (e) {
      avisar((e as Error).message, true);
      setCargando(false);
    }
  };
  const setE = (i: number, c: Partial<Escenario>) => setEscenarios(escenarios.map((e, j) => (j === i ? { ...e, ...c } : e)));
  return (
    <Modal grande titulo="Nueva simulación" onCerrar={onCerrar} pie={<>
      <Boton onClick={onCerrar}>Cancelar</Boton>
      <Boton variante="primario" icono="play_arrow" cargando={cargando} disabled={propios && escenarios.length === 0} onClick={crear}>
        {propios ? "Correr" : "Generar escenarios y correr"}
      </Boton>
    </>}>
      <div className="rejilla c3">
        <Campo etiqueta="Nombre"><input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
        <Campo etiqueta="Turnos máximos"><Num valor={maxTurnos} min={2} max={20} onCambio={setMaxTurnos} /></Campo>
        {!propios && <Campo etiqueta="Escenarios a generar"><Num valor={n} min={1} max={20} onCambio={setN} /></Campo>}
      </div>
      <Check valor={borrador} onCambio={setBorrador}>Probar el borrador (si no, la versión publicada)</Check>
      <Check valor={propios} onCambio={setPropios}>Definir mis propios escenarios</Check>
      {propios && (
        <div className="pila c">
          {escenarios.map((e, i) => (
            <div key={i} className="tarjeta plana pila c" style={{ padding: "var(--padding-12)" }}>
              <div className="fila" style={{ flexWrap: "nowrap" }}>
                <input type="text" placeholder="Nombre del escenario" value={e.nombre} onChange={(x) => setE(i, { nombre: x.target.value })} />
                <select value={e.comportamiento} onChange={(x) => setE(i, { comportamiento: x.target.value })} style={{ maxWidth: 240 }}>
                  {comps.map((c) => <option key={c}>{c}</option>)}
                </select>
                <select value={e.canal} onChange={(x) => setE(i, { canal: x.target.value })} style={{ maxWidth: 140 }}>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="voz">Voz</option>
                </select>
                <Boton chico icono="delete" onClick={() => setEscenarios(escenarios.filter((_, j) => j !== i))} />
              </div>
              <input type="text" placeholder="Persona: quién es, contexto, datos (p. ej. gerente de RR. HH. de una empresa de 200 personas)" value={e.persona} onChange={(x) => setE(i, { persona: x.target.value })} />
              <input type="text" placeholder="Objetivo del contacto" value={e.objetivo} onChange={(x) => setE(i, { objetivo: x.target.value })} />
            </div>
          ))}
          <Boton chico icono="add" onClick={() => setEscenarios([...escenarios, { nombre: `Escenario ${escenarios.length + 1}`, persona: "", comportamiento: comps[0] ?? "cooperativo", objetivo: "", canal: "whatsapp" }])}>
            Escenario
          </Boton>
        </div>
      )}
      <Campo etiqueta="Rúbrica (un criterio por línea)" ayuda={`Vacío = rúbrica por defecto: ${(lista.datos?.rubrica ?? []).join(" · ")}`}>
        <textarea rows={4} value={rubrica} onChange={(e) => setRubrica(e.target.value)} />
      </Campo>
    </Modal>
  );
}

function tonoPuntaje(p: number | null | undefined) {
  if (p === null || p === undefined) return "" as const;
  return p >= 8 ? ("ok" as const) : p >= 6 ? ("aviso" as const) : ("error" as const);
}

function DetalleSimulacion({ id, onCerrar, onRepetida }: { id: number; onCerrar: () => void; onRepetida: () => void }) {
  const avisar = useAvisos();
  const { datos: s, recargar } = useCarga(() => api.get<Simulacion>(`/api/simulaciones/${id}`), [id]);
  const [abierto, setAbierto] = useState<number | null>(0);
  useIntervalo(recargar, s && (s.estado === "corriendo" || s.estado === "pendiente") ? 2500 : null);
  const repetir = async () => {
    try {
      await api.post(`/api/simulaciones/${id}/repetir`);
      avisar("Simulación repetida");
      onRepetida();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const resultados = s?.resultados ?? [];
  const sugerencias = [...new Set(resultados.flatMap((r) => r.evaluacion?.sugerencias_prompt ?? []))];
  return (
    <Cajon titulo={s?.nombre ?? "Simulación"} onCerrar={onCerrar} pie={<Boton icono="replay" onClick={repetir}>Repetir</Boton>}>
      {!s ? null : (
        <>
          <div className="fila">
            {s.estado === "corriendo" || s.estado === "pendiente"
              ? <Insignia tono="info"><Icono n="progress_activity" className="giro" /> Corriendo {s.n_resultados}/{s.n_escenarios}</Insignia>
              : s.estado === "fallida" ? <Insignia tono="error">Fallida</Insignia> : <Insignia tono="ok">Lista</Insignia>}
            {s.puntaje !== null && <Insignia tono={tonoPuntaje(s.puntaje)}>Puntaje {s.puntaje}/10</Insignia>}
            <span className="chico tenue">{s.usar_borrador ? "Borrador" : "Publicado"} · {fmt.relativa(s.creado)}</span>
          </div>
          {s.error && <Banner tono="error">{s.error}</Banner>}
          {sugerencias.length > 0 && (
            <Tarjeta titulo="Sugerencias para el prompt" icono="tips_and_updates">
              <ul style={{ margin: 0, paddingLeft: 18 }}>{sugerencias.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </Tarjeta>
          )}
          {resultados.map((r, i) => (
            <div key={i} className="tarjeta" style={{ padding: "var(--padding-12)" }}>
              <div className="fila e" style={{ cursor: "pointer" }} onClick={() => setAbierto(abierto === i ? null : i)}>
                <div className="crece">
                  <div style={{ fontWeight: 600 }}>{r.escenario.nombre}</div>
                  <div className="chico tenue">{r.escenario.comportamiento} · {r.escenario.canal} · fin: {r.fin}</div>
                </div>
                {r.evaluacion?.objetivo_cumplido ? <Insignia tono="ok">Objetivo cumplido</Insignia> : <Insignia tono="aviso">Objetivo no cumplido</Insignia>}
                <Insignia tono={tonoPuntaje(r.evaluacion?.puntaje)}>{r.evaluacion?.puntaje ?? "—"}/10</Insignia>
                <Icono n={abierto === i ? "expand_less" : "expand_more"} />
              </div>
              {abierto === i && (
                <div className="pila" style={{ marginTop: "var(--gap-12)" }}>
                  <div className="chico tenue"><b>Persona:</b> {r.escenario.persona}<br /><b>Objetivo:</b> {r.escenario.objetivo}</div>
                  <table className="tabla">
                    <tbody>
                      {(r.evaluacion?.criterios ?? []).map((c, j) => (
                        <tr key={j}><td>{c.criterio}<div className="chico tenue">{c.comentario}</div></td><td className="num"><Insignia tono={tonoPuntaje(c.puntaje)}>{c.puntaje}</Insignia></td></tr>
                      ))}
                    </tbody>
                  </table>
                  {(r.evaluacion?.problemas ?? []).length > 0 && (
                    <Banner tono="aviso" icono="report"><ul style={{ margin: 0, paddingLeft: 18 }}>{r.evaluacion.problemas.map((p, j) => <li key={j}>{p}</li>)}</ul></Banner>
                  )}
                  <div className="chat tarjeta plana" style={{ maxHeight: 420 }}>
                    {r.transcript.map((t, j) => (
                      <div key={j} style={{ display: "contents" }}>
                        {(t.herramientas ?? []).map((h, k) => (
                          <details key={k} className="herramienta-chip">
                            <summary><Icono n="build" /> {h.nombre}</summary>
                            <pre className="chico tenue">{h.resultado}</pre>
                          </details>
                        ))}
                        {t.texto && <div className={`burbuja ${t.rol === "agente" ? "saliente" : "entrante"}`}>{t.texto}</div>}
                      </div>
                    ))}
                  </div>
                  <span className="chico tenue">Costo {fmt.usd(r.costo)}</span>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </Cajon>
  );
}

export function PestanaSimulador({ agente, editable }: PropsPestana) {
  const lista = useCarga(() => api.get<Simulacion[]>(`/api/agentes/${agente.id}/simulaciones`), [agente.id]);
  const [nueva, setNueva] = useState(false);
  const [ver, setVer] = useState<number | null>(null);
  const corriendo = (lista.datos ?? []).some((s) => s.estado === "corriendo" || s.estado === "pendiente");
  useIntervalo(lista.recargar, corriendo ? 3000 : null);
  return (
    <Tarjeta titulo="Simulador de personas" icono="smart_toy" acciones={editable && <Boton variante="primario" icono="add" onClick={() => setNueva(true)}>Nueva simulación</Boton>}>
      <Ayuda>Un modelo hace de contacto (apurado, escéptico, pide humano…) y conversa con tu agente; un juez califica con una rúbrica. Corre sin telefonía ni WhatsApp: pruebas antes de gastar llamadas reales.</Ayuda>
      {lista.datos && lista.datos.length === 0 ? (
        <Vacio icono="smart_toy" titulo="Sin simulaciones aún">Genera escenarios automáticos a partir del prompt del agente.</Vacio>
      ) : (
        <div className="tabla-env" style={{ marginTop: "var(--gap-12)" }}>
          <table className="tabla">
            <thead><tr><th>Simulación</th><th>Estado</th><th className="num">Escenarios</th><th className="num">Puntaje</th><th>Fecha</th></tr></thead>
            <tbody>
              {(lista.datos ?? []).map((s) => (
                <tr key={s.id} className="clic" onClick={() => setVer(s.id)}>
                  <td>{s.nombre}<div className="chico tenue">{s.usar_borrador ? "Borrador" : "Publicado"}</div></td>
                  <td>{s.estado === "lista" ? <Insignia tono="ok">Lista</Insignia> : s.estado === "fallida" ? <Insignia tono="error">Fallida</Insignia>
                    : <Insignia tono="info"><Icono n="progress_activity" className="giro" /> {s.n_resultados}/{s.n_escenarios}</Insignia>}</td>
                  <td className="num">{s.n_escenarios}</td>
                  <td className="num">{s.puntaje !== null ? <Insignia tono={tonoPuntaje(s.puntaje)}>{s.puntaje}</Insignia> : "—"}</td>
                  <td className="tenue">{fmt.relativa(s.creado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nueva && <NuevaSimulacion agenteId={agente.id} onCerrar={() => setNueva(false)} onCreada={(s) => { setNueva(false); lista.recargar(); setVer(s.id); }} />}
      {ver !== null && <DetalleSimulacion id={ver} onCerrar={() => setVer(null)} onRepetida={() => { setVer(null); lista.recargar(); }} />}
    </Tarjeta>
  );
}
