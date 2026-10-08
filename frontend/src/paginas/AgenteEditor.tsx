// Editor de un agente: borrador → probar → publicar, con todas las pestañas de configuración.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Ayuda, Deslizador, EditorKV, Num, type PropsPestana } from "../componentes/agente-comun";
import PestanaHerramientas from "../componentes/agente-herramientas";
import { PestanaProbar, PestanaSimulador } from "../componentes/agente-probar";
import PestanaVoz from "../componentes/agente-voz";
import {
  Banner, Boton, Campo, Cargando, Check, Insignia, ListaTextos, Modal, Pestanas, Tarjeta, Vacio, fmt, useAvisos, useCarga,
} from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Agente, CampoAnalisis, Cerebro, ConfigAgente } from "../tipos";

type IdPestana = "instrucciones" | "modelo" | "herramientas" | "conversacion" | "voz" | "analisis" | "probar" | "simulador" | "versiones" | "integrar";
const PESTANAS: { id: IdPestana; texto: string; icono: string }[] = [
  { id: "instrucciones", texto: "Instrucciones", icono: "description" },
  { id: "modelo", texto: "Modelo y conocimiento", icono: "psychology" },
  { id: "herramientas", texto: "Herramientas", icono: "construction" },
  { id: "conversacion", texto: "Conversación", icono: "forum" },
  { id: "voz", texto: "Voz", icono: "call" },
  { id: "analisis", texto: "Análisis", icono: "analytics" },
  { id: "probar", texto: "Probar", icono: "science" },
  { id: "simulador", texto: "Simulador", icono: "smart_toy" },
  { id: "versiones", texto: "Versiones", icono: "history" },
  { id: "integrar", texto: "Integrar", icono: "code" },
];

// ───────── 1. Instrucciones ─────────

function PestanaInstrucciones({ cfg, setCfg, editable }: PropsPestana) {
  const set = (c: Partial<ConfigAgente>) => setCfg({ ...cfg, ...c });
  return (
    <div className="pila">
      <Tarjeta titulo="Prompt" icono="description">
        <div className="pila">
          <Campo etiqueta="Propósito" ayuda="Una frase. Lo usan el análisis y el simulador para juzgar si el agente cumplió.">
            <input type="text" value={cfg.proposito} disabled={!editable} onChange={(e) => set({ proposito: e.target.value })}
              placeholder="Calificar empresas interesadas y agendar una reunión con un asesor" />
          </Campo>
          <Campo etiqueta="Instrucciones" ayuda={`${cfg.instrucciones.length.toLocaleString("es-CO")} caracteres. Rol, objetivo, guion por etapas, manejo de objeciones, límites y estilo.`}>
            <textarea className="codigo" rows={20} value={cfg.instrucciones} disabled={!editable} onChange={(e) => set({ instrucciones: e.target.value })} />
          </Campo>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Inicio de la conversación" icono="waving_hand">
        <div className="pila">
          <Campo etiqueta="¿Quién habla primero?">
            <select value={cfg.quien_habla_primero} disabled={!editable} onChange={(e) => set({ quien_habla_primero: e.target.value as "agente" | "contacto" })}>
              <option value="agente">El agente saluda</option>
              <option value="contacto">El agente espera al contacto</option>
            </select>
          </Campo>
          {cfg.quien_habla_primero === "agente" && (
            <Campo etiqueta="Mensaje inicial" ayuda="Se usa en voz y en el widget. En WhatsApp saliente el primer mensaje es la plantilla.">
              <textarea rows={2} value={cfg.mensaje_inicial} disabled={!editable} onChange={(e) => set({ mensaje_inicial: e.target.value })}
                placeholder="Hola {{primer_nombre}}, te habla Sofía de Platzi. ¿Tienes un minuto?" />
            </Campo>
          )}
          <Check valor={cfg.usar_contexto_empresa} onCambio={(v) => editable && set({ usar_contexto_empresa: v })}>
            Incluir el contexto de la empresa (Ajustes → Espacio) en el prompt
          </Check>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Variables" icono="data_object">
        <Ayuda>
          Escribe <code>{"{{variable}}"}</code> en el prompt o en los mensajes. Siempre disponibles: <code>nombre</code>, <code>primer_nombre</code>,{" "}
          <code>empresa</code>, <code>telefono</code>, <code>email</code> y los atributos del contacto. Aquí defines valores por defecto (y la
          apariencia del widget con <code>widget_titulo</code>, <code>widget_color</code>, <code>widget_pedir_datos</code>).
        </Ayuda>
        <div style={{ marginTop: "var(--gap-12)" }}>
          <EditorKV valor={cfg.variables} disabled={!editable} placeholderClave="variable" onCambio={(v) => set({ variables: v })} />
        </div>
      </Tarjeta>
    </div>
  );
}

// ───────── 2. Modelo y conocimiento ─────────

const PROVEEDORES = [["", "El de la instancia"], ["anthropic", "Anthropic (Claude)"], ["openai", "OpenAI"], ["groq", "Groq"], ["gemini", "Google Gemini"], ["ollama", "Ollama (local)"]];

function PestanaModelo({ cfg, setCfg, editable }: PropsPestana) {
  const opciones = useCarga(() => api.get<{ modelos: Record<string, string[]> }>("/api/agentes/opciones"));
  const cerebros = useCarga(() => api.get<Cerebro[]>("/api/cerebros"));
  const m = cfg.modelo;
  const k = cfg.conocimiento;
  const setM = (c: Partial<typeof m>) => setCfg({ ...cfg, modelo: { ...m, ...c } });
  const setK = (c: Partial<typeof k>) => setCfg({ ...cfg, conocimiento: { ...k, ...c } });
  const sugeridos = m.proveedor ? opciones.datos?.modelos[m.proveedor] ?? [] : Object.values(opciones.datos?.modelos ?? {}).flat();
  return (
    <div className="pila">
      <Tarjeta titulo="Modelo" icono="memory">
        <div className="rejilla c2">
          <Campo etiqueta="Proveedor">
            <select value={m.proveedor} disabled={!editable} onChange={(e) => setM({ proveedor: e.target.value, nombre: "" })}>
              {PROVEEDORES.map(([id, t]) => <option key={id} value={id}>{t}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Modelo" ayuda="Vacío = el modelo por defecto de la instancia. Para voz usa un modelo rápido con herramientas nativas.">
            <input type="text" className="mono" list="modelos-sugeridos" value={m.nombre} disabled={!editable} onChange={(e) => setM({ nombre: e.target.value })} />
            <datalist id="modelos-sugeridos">{sugeridos.map((s) => <option key={s} value={s} />)}</datalist>
          </Campo>
          <Campo etiqueta="Temperatura" ayuda="Bajo = consistente; alto = creativo.">
            <Deslizador valor={m.temperatura} min={0} max={1.5} paso={0.05} disabled={!editable} onCambio={(v) => setM({ temperatura: v })} />
          </Campo>
          <Campo etiqueta="Máximo de tokens por respuesta"><Num valor={m.max_tokens} min={50} max={8000} disabled={!editable} onCambio={(v) => setM({ max_tokens: v })} /></Campo>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Conocimiento" icono="psychology" acciones={<Link to="/conocimiento" className="btn texto chico">Gestionar cerebros</Link>}>
        {cerebros.datos && cerebros.datos.length === 0 ? (
          <Banner icono="psychology">No hay cerebros. Crea uno en Conocimiento con tu web, PDFs o texto.</Banner>
        ) : (
          <div className="pila">
            <Campo etiqueta="Cerebros que consulta">
              <div className="pila c">
                {(cerebros.datos ?? []).map((c) => (
                  <Check key={c.id} valor={k.cerebro_ids.includes(c.id)}
                    onCambio={(v) => editable && setK({ cerebro_ids: v ? [...k.cerebro_ids, c.id] : k.cerebro_ids.filter((x) => x !== c.id) })}>
                    {c.nombre} <span className="tenue chico">· {c.n_fuentes ?? 0} fuentes · {c.n_fragmentos ?? 0} fragmentos</span>
                  </Check>
                ))}
              </div>
            </Campo>
            <div className="rejilla c2">
              <Campo etiqueta="Fragmentos por búsqueda (top k)"><Deslizador valor={k.top_k} min={1} max={12} paso={1} disabled={!editable} onCambio={(v) => setK({ top_k: v })} /></Campo>
              <Campo etiqueta="Similitud mínima" ayuda="Descarta resultados poco relevantes."><Deslizador valor={k.umbral} min={0} max={1} paso={0.05} disabled={!editable} onCambio={(v) => setK({ umbral: v })} /></Campo>
            </div>
            <Check valor={k.mostrar_fuentes} onCambio={(v) => editable && setK({ mostrar_fuentes: v })}>Citar las fuentes (enlaces) en canales de texto</Check>
            {k.cerebro_ids.length > 0 && !cfg.herramientas.some((h) => h.tipo === "buscar_conocimiento" && h.activa) && (
              <Banner tono="aviso">Activa la herramienta «Buscar en conocimiento» para que el agente use estos cerebros.</Banner>
            )}
          </div>
        )}
      </Tarjeta>
    </div>
  );
}

// ───────── 4. Conversación ─────────

function PestanaConversacion({ cfg, setCfg, editable }: PropsPestana) {
  const c = cfg.conversacion;
  const set = (x: Partial<typeof c>) => setCfg({ ...cfg, conversacion: { ...c, ...x } });
  return (
    <div className="pila">
      <Tarjeta titulo="Ritmo" icono="schedule">
        <div className="rejilla c2">
          <Campo etiqueta="Cerrar por inactividad (min)" ayuda="Al cerrar se corre el análisis."><Num valor={c.cierre_inactividad_min} min={10} max={1440} disabled={!editable} onCambio={(v) => set({ cierre_inactividad_min: v })} /></Campo>
          <Campo etiqueta="Demora antes de responder (s)" ayuda="En WhatsApp se agrupan ráfagas (mínimo 2 s)."><Num valor={c.demora_respuesta_s} min={0} max={60} paso={0.5} disabled={!editable} onCambio={(v) => set({ demora_respuesta_s: v })} /></Campo>
        </div>
        <div style={{ marginTop: 12 }}>
          <Check valor={c.partir_respuestas} onCambio={(v) => editable && set({ partir_respuestas: v })}>Partir respuestas largas en varios mensajes (WhatsApp)</Check>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Seguimientos automáticos" icono="notifications_active">
        <Ayuda>Si el contacto deja de responder, el agente escribe de nuevo (hasta 3 veces). En WhatsApp solo dentro de la ventana de 24 h.</Ayuda>
        <div className="pila c" style={{ marginTop: "var(--gap-12)" }}>
          {c.seguimientos.map((s, i) => (
            <div key={i} className="tarjeta plana pila c" style={{ padding: "var(--padding-12)" }}>
              <div className="fila" style={{ flexWrap: "nowrap" }}>
                <span className="chico" style={{ whiteSpace: "nowrap" }}>#{i + 1} tras</span>
                <span style={{ width: 100 }}><Num valor={s.tras_min} min={5} max={1440} disabled={!editable} onCambio={(v) => set({ seguimientos: c.seguimientos.map((x, j) => (j === i ? { ...x, tras_min: v } : x)) })} /></span>
                <span className="chico">min</span>
                <select value={s.tipo} disabled={!editable} style={{ maxWidth: 220 }} onChange={(e) => set({ seguimientos: c.seguimientos.map((x, j) => (j === i ? { ...x, tipo: e.target.value as "ia" | "estatico" } : x)) })}>
                  <option value="ia">Lo redacta la IA</option>
                  <option value="estatico">Texto fijo</option>
                </select>
                <span className="crece" />
                {editable && <Boton chico icono="delete" onClick={() => set({ seguimientos: c.seguimientos.filter((_, j) => j !== i) })} />}
              </div>
              <textarea rows={2} value={s.contenido} disabled={!editable}
                placeholder={s.tipo === "ia" ? "Instrucción: p. ej. recuérdale la reunión y ofrece dos horarios" : "Hola {{primer_nombre}}, ¿pudiste revisar la propuesta?"}
                onChange={(e) => set({ seguimientos: c.seguimientos.map((x, j) => (j === i ? { ...x, contenido: e.target.value } : x)) })} />
            </div>
          ))}
          {editable && c.seguimientos.length < 3 && (
            <Boton chico icono="add" onClick={() => set({ seguimientos: [...c.seguimientos, { tras_min: 60 * (c.seguimientos.length + 1), tipo: "ia", contenido: "" }] })}>Seguimiento</Boton>
          )}
        </div>
      </Tarjeta>
      <Tarjeta titulo="Bajas (opt-out)" icono="block">
        <Campo etiqueta="Palabras que dan de baja al contacto" ayuda="Si el mensaje es exactamente una de estas (o la contiene, si es una frase), se marca opt-out y se detienen sus campañas.">
          <ListaTextos valor={c.palabras_baja} onCambio={(v) => editable && set({ palabras_baja: v })} />
        </Campo>
      </Tarjeta>
    </div>
  );
}

// ───────── 6. Análisis ─────────

function PestanaAnalisis({ cfg, setCfg, editable }: PropsPestana) {
  const a = cfg.analisis;
  const set = (x: Partial<typeof a>) => setCfg({ ...cfg, analisis: { ...a, ...x } });
  const setCampo = (i: number, x: Partial<CampoAnalisis>) => set({ campos: a.campos.map((c, j) => (j === i ? { ...c, ...x } : c)) });
  return (
    <div className="pila">
      <Tarjeta titulo="Análisis al cerrar" icono="analytics">
        <div className="pila">
          <Check valor={a.activo} onCambio={(v) => editable && set({ activo: v })}>Analizar cada conversación y llamada contestada al terminar</Check>
          <Campo etiqueta="Instrucción del resumen"><textarea rows={2} value={a.resumen_prompt} disabled={!editable} onChange={(e) => set({ resumen_prompt: e.target.value })} /></Campo>
          <Campo etiqueta="¿Cuándo es un éxito?"><textarea rows={2} value={a.exito_prompt} disabled={!editable} onChange={(e) => set({ exito_prompt: e.target.value })} /></Campo>
          <div className="rejilla c2">
            <Campo etiqueta="Etapa del contacto si fue exitosa"><input type="text" value={a.etapa_si_exito} disabled={!editable} placeholder="calificado" onChange={(e) => set({ etapa_si_exito: e.target.value })} /></Campo>
            <Campo etiqueta="Etapa si no"><input type="text" value={a.etapa_si_fracaso} disabled={!editable} placeholder="nutrir" onChange={(e) => set({ etapa_si_fracaso: e.target.value })} /></Campo>
          </div>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Datos a extraer" icono="dataset">
        <Ayuda>Cada campo se extrae del transcript con salida estructurada. «Persistente» se acumula en el contacto entre conversaciones; «sesión» queda solo en la conversación. Salen en el webhook conversacion.analizada / llamada.analizada.</Ayuda>
        <div className="pila c" style={{ marginTop: "var(--gap-12)" }}>
          {a.campos.map((c, i) => (
            <div key={i} className="tarjeta plana pila c" style={{ padding: "var(--padding-12)" }}>
              <div className="fila" style={{ flexWrap: "nowrap" }}>
                <input type="text" className="mono" placeholder="nombre" value={c.nombre} disabled={!editable} style={{ maxWidth: 200 }} onChange={(e) => setCampo(i, { nombre: e.target.value.replace(/\s/g, "_") })} />
                <select value={c.tipo} disabled={!editable} style={{ maxWidth: 130 }} onChange={(e) => setCampo(i, { tipo: e.target.value as CampoAnalisis["tipo"] })}>
                  {["texto", "numero", "booleano", "enum"].map((t) => <option key={t}>{t}</option>)}
                </select>
                <select value={c.alcance} disabled={!editable} style={{ maxWidth: 150 }} onChange={(e) => setCampo(i, { alcance: e.target.value as CampoAnalisis["alcance"] })}>
                  <option value="sesion">Sesión</option>
                  <option value="persistente">Persistente</option>
                </select>
                <Check valor={c.requerido} onCambio={(v) => editable && setCampo(i, { requerido: v })}>Requerido</Check>
                {editable && <Boton chico icono="delete" onClick={() => set({ campos: a.campos.filter((_, j) => j !== i) })} />}
              </div>
              <input type="text" placeholder="Qué extraer y cómo (p. ej. «Número de colaboradores a capacitar»)" value={c.descripcion} disabled={!editable} onChange={(e) => setCampo(i, { descripcion: e.target.value })} />
              {c.tipo === "enum" && (
                <input type="text" placeholder="Opciones separadas por coma" value={c.opciones.join(", ")} disabled={!editable}
                  onChange={(e) => setCampo(i, { opciones: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              )}
            </div>
          ))}
          {editable && (
            <Boton chico icono="add" onClick={() => set({ campos: [...a.campos, { nombre: "", tipo: "texto", descripcion: "", opciones: [], requerido: false, alcance: "sesion" }] })}>Campo</Boton>
          )}
        </div>
      </Tarjeta>
    </div>
  );
}

// ───────── 9. Versiones ─────────

interface Version { numero: number; nota: string; publicado_por: number | null; creado: string; config: ConfigAgente }

function PestanaVersiones({ agente, cfg, editable, onRestaurado }: PropsPestana & { onRestaurado: (a: Agente) => void }) {
  const avisar = useAvisos();
  const { datos } = useCarga(() => api.get<Version[]>(`/api/agentes/${agente.id}/versiones`), [agente.id, agente.version_publicada]);
  const [sel, setSel] = useState<number | null>(null);
  const v = datos?.find((x) => x.numero === sel) ?? datos?.[0];
  const restaurar = async (n: number) => {
    if (!confirm(`¿Restaurar la v${n}? Reemplaza el borrador y se publica como una versión nueva.`)) return;
    try {
      const a = await api.post<Agente>(`/api/agentes/${agente.id}/versiones/${n}/restaurar`);
      avisar(`v${n} restaurada como v${a.version_publicada}`);
      onRestaurado(a);
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  if (!datos) return <Cargando />;
  if (datos.length === 0) return <Vacio icono="history" titulo="Sin versiones publicadas">Cada vez que publicas se guarda una versión para poder volver atrás.</Vacio>;
  return (
    <div className="rejilla" style={{ gridTemplateColumns: "260px 1fr" }}>
      <div className="pila c">
        {datos.map((x) => (
          <button key={x.numero} className={`tarjeta ${v?.numero === x.numero ? "" : "plana"}`} style={{ textAlign: "left", cursor: "pointer", color: "inherit", padding: "var(--padding-12)" }} onClick={() => setSel(x.numero)}>
            <div className="fila e">
              <b>v{x.numero}</b>
              {x.numero === agente.version_publicada && <Insignia tono="ok">En producción</Insignia>}
            </div>
            <div className="chico tenue">{fmt.fecha(x.creado)}</div>
            {x.nota && <div className="chico">{x.nota}</div>}
          </button>
        ))}
      </div>
      {v && (
        <Tarjeta titulo={`Instrucciones: v${v.numero} vs. borrador actual`} icono="compare" acciones={editable && v.numero !== agente.version_publicada &&
          <Boton icono="restore" onClick={() => restaurar(v.numero)}>Restaurar v{v.numero}</Boton>}>
          <div className="rejilla c2">
            <pre className="tarjeta plana chico" style={{ maxHeight: 520, overflow: "auto" }}>{v.config.instrucciones}</pre>
            <pre className="tarjeta plana chico" style={{ maxHeight: 520, overflow: "auto" }}>{cfg.instrucciones}</pre>
          </div>
          {v.config.instrucciones === cfg.instrucciones && <div className="chico tenue" style={{ marginTop: 8 }}>Las instrucciones son idénticas.</div>}
        </Tarjeta>
      )}
    </div>
  );
}

// ───────── 10. Integrar ─────────

function PestanaIntegrar({ agente }: PropsPestana) {
  const avisar = useAvisos();
  const snippet = `<script src="${location.origin}/widget.js" data-agente="${agente.clave_publica}" async></script>`;
  const copiar = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      avisar("Copiado");
    } catch {
      avisar("No se pudo copiar", true);
    }
  };
  return (
    <div className="pila">
      <Tarjeta titulo="Widget web (chat + voz)" icono="language" acciones={<Boton icono="content_copy" onClick={() => copiar(snippet)}>Copiar</Boton>}>
        {!agente.publicado && <Banner tono="aviso">El widget solo funciona con un agente publicado.</Banner>}
        <pre className="tarjeta plana" style={{ marginTop: 12 }}>{snippet}</pre>
        <Ayuda>
          Pégalo antes de <code>&lt;/body&gt;</code>. Personaliza con variables del agente: <code>widget_titulo</code>, <code>widget_color</code> (p. ej. #0ae98a) y{" "}
          <code>widget_pedir_datos</code> = <code>si</code> para pedir nombre y teléfono antes de chatear. Si el agente está sincronizado con Retell aparece el botón de llamada.
        </Ayuda>
      </Tarjeta>
      <Tarjeta titulo="WhatsApp" icono="chat">
        <p style={{ margin: 0 }}>Asigna este agente a una línea en <Link to="/canales">Canales → WhatsApp</Link>: responderá los mensajes entrantes de esa línea.</p>
      </Tarjeta>
      <Tarjeta titulo="Llamadas entrantes y campañas" icono="call">
        <p style={{ margin: 0 }}>
          Asígnalo como agente entrante de un número en <Link to="/canales">Canales → Voz</Link>, o úsalo en el A/B de una <Link to="/secuencias">campaña</Link>.
        </p>
      </Tarjeta>
      <Tarjeta titulo="Identificadores" icono="key">
        <div className="pila c mono chico">
          <span>agente_id: {agente.id}</span>
          <span>clave_publica: {agente.clave_publica}</span>
          {agente.retell_agent_id && <span>retell_agent_id: {agente.retell_agent_id}</span>}
        </div>
      </Tarjeta>
    </div>
  );
}

// ───────── Página ─────────

function ModalPublicar({ onCerrar, onPublicar }: { onCerrar: () => void; onPublicar: (nota: string) => Promise<void> }) {
  const [nota, setNota] = useState("");
  const [cargando, setCargando] = useState(false);
  return (
    <Modal titulo="Publicar agente" onCerrar={onCerrar} pie={<>
      <Boton onClick={onCerrar}>Cancelar</Boton>
      <Boton variante="primario" icono="rocket_launch" cargando={cargando} onClick={async () => { setCargando(true); await onPublicar(nota); setCargando(false); }}>Publicar</Boton>
    </>}>
      <p style={{ margin: 0 }}>El borrador pasa a producción en todos los canales y se sincroniza la voz con Retell. Puedes volver a una versión anterior cuando quieras.</p>
      <Campo etiqueta="Nota de la versión (opcional)"><input type="text" autoFocus value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Qué cambió" /></Campo>
    </Modal>
  );
}

export default function AgenteEditor() {
  const { id } = useParams();
  const navegar = useNavigate();
  const avisar = useAvisos();
  const { puede } = useSesion();
  const editable = puede("editor");
  const { datos: agente, setDatos: setAgente, error } = useCarga(() => api.get<Agente>(`/api/agentes/${id}`), [id]);
  const [cfg, setCfgLocal] = useState<ConfigAgente | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [sucio, setSucio] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [publicar, setPublicar] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pestana, setPestana] = useState<IdPestana>(() => (location.hash.slice(1) as IdPestana) || "instrucciones");

  useEffect(() => {
    if (agente?.config && !sucio) {
      setCfgLocal(agente.config);
      setNombre(agente.nombre);
      setDescripcion(agente.descripcion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agente]);
  useEffect(() => { history.replaceState(null, "", `#${pestana}`); }, [pestana]);
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => { if (sucio) e.preventDefault(); };
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [sucio]);

  const setCfg = (c: ConfigAgente) => { setCfgLocal(c); setSucio(true); };

  const guardar = async (): Promise<boolean> => {
    if (!cfg) return false;
    setGuardando(true);
    try {
      const a = await api.patch<Agente>(`/api/agentes/${id}`, { nombre, descripcion, config: cfg });
      setAgente(a);
      setCfgLocal(a.config!);
      setSucio(false);
      return true;
    } catch (e) {
      avisar((e as Error).message, true);
      return false;
    } finally {
      setGuardando(false);
    }
  };

  const hacerPublicar = async (nota: string) => {
    if (sucio && !(await guardar())) return;
    try {
      const a = await api.post<Agente>(`/api/agentes/${id}/publicar`, { nota });
      setAgente(a);
      setAviso(a.aviso ?? null);
      setPublicar(false);
      avisar(`Publicada la v${a.version_publicada}`);
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };

  if (error) return <div className="pagina"><Banner tono="error">{error}</Banner></div>;
  if (!agente || !cfg) return <Cargando />;

  const props: PropsPestana = { agente, cfg, setCfg, editable };
  return (
    <div className="pagina">
      <div className="encabezado">
        <div className="crece">
          <div className="fila" style={{ gap: "var(--gap-8)" }}>
            <Boton variante="texto" icono="arrow_back" aria-label="Volver"
              onClick={() => (!sucio || confirm("Tienes cambios sin guardar. ¿Salir de todas formas?")) && navegar("/agentes")} />
            <input type="text" value={nombre} disabled={!editable} aria-label="Nombre del agente"
              onChange={(e) => { setNombre(e.target.value); setSucio(true); }}
              style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, background: "transparent", border: "1px solid transparent", flex: "1 1 200px", minWidth: 0, maxWidth: 420 }} />
            {agente.publicado ? <Insignia tono="ok" punto>v{agente.version_publicada} en producción</Insignia> : <Insignia>Sin publicar</Insignia>}
            {sucio ? <Insignia tono="aviso">Cambios sin guardar</Insignia> : agente.cambios_sin_publicar && <Insignia tono="info">Borrador distinto de producción</Insignia>}
          </div>
          <input type="text" value={descripcion} disabled={!editable} placeholder="Descripción interna" className="chico"
            onChange={(e) => { setDescripcion(e.target.value); setSucio(true); }}
            style={{ background: "transparent", border: "1px solid transparent", marginLeft: 44, width: "calc(100% - 44px)", maxWidth: 520, color: "var(--on-surface-variant)" }} />
        </div>
        {editable && (
          <div className="acciones">
            <Boton icono="save" disabled={!sucio} cargando={guardando} onClick={guardar}>Guardar</Boton>
            <Boton variante="primario" icono="rocket_launch" onClick={() => setPublicar(true)}>Publicar</Boton>
          </div>
        )}
      </div>
      {aviso && <div style={{ marginBottom: 16 }}><Banner tono="aviso" icono="warning">{aviso}</Banner></div>}
      {!editable && <div style={{ marginBottom: 16 }}><Banner icono="visibility">Modo lectura: tu rol no permite editar agentes.</Banner></div>}
      <Pestanas valor={pestana} onCambio={setPestana} opciones={PESTANAS} />
      {pestana === "instrucciones" && <PestanaInstrucciones {...props} />}
      {pestana === "modelo" && <PestanaModelo {...props} />}
      {pestana === "herramientas" && <PestanaHerramientas {...props} />}
      {pestana === "conversacion" && <PestanaConversacion {...props} />}
      {pestana === "voz" && <PestanaVoz {...props} />}
      {pestana === "analisis" && <PestanaAnalisis {...props} />}
      {pestana === "probar" && (
        <>
          {sucio && <div style={{ marginBottom: 12 }}><Banner tono="aviso">Guarda los cambios para probarlos. <Boton chico variante="texto" onClick={guardar}>Guardar ahora</Boton></Banner></div>}
          <PestanaProbar {...props} />
        </>
      )}
      {pestana === "simulador" && <PestanaSimulador {...props} />}
      {pestana === "versiones" && <PestanaVersiones {...props} onRestaurado={(a) => { setAgente(a); setSucio(false); setCfgLocal(a.config!); }} />}
      {pestana === "integrar" && <PestanaIntegrar {...props} />}
      {publicar && <ModalPublicar onCerrar={() => setPublicar(false)} onPublicar={hacerPublicar} />}
    </div>
  );
}
