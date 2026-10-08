// Ajustes → Integraciones, API y MCP, Webhooks y Eventos.
import { Fragment, useState } from "react";
import { api, qs } from "../api";
import { Banner, Boton, Campo, Cargando, Check, Icono, Insignia, Modal, Tarjeta, Vacio, fmt, useAvisos, useCarga } from "./ui";

export function copiar(texto: string, avisar: (t: string) => void) {
  navigator.clipboard?.writeText(texto).then(() => avisar("Copiado"), () => avisar("No se pudo copiar"));
}

// ───────── Integraciones ─────────

interface Integracion {
  tipo: string;
  configurada: boolean;
  origen: "espacio" | "instancia" | null;
  valores: Record<string, string | number | null>;
}

const INFO: Record<string, { nombre: string; icono: string; ayuda: string; campos: Record<string, { rotulo: string; secreto?: boolean; tipo?: string }> }> = {
  anthropic: { nombre: "Anthropic (Claude)", icono: "auto_awesome", ayuda: "Modelo recomendado para voz y herramientas. Crea la clave en console.anthropic.com → API Keys.", campos: { api_key: { rotulo: "API key", secreto: true } } },
  openai: { nombre: "OpenAI", icono: "bolt", ayuda: "Modelos GPT y embeddings opcionales. platform.openai.com → API keys. La URL base permite usar otro proveedor compatible; en producción debe ser pública.", campos: { api_key: { rotulo: "API key", secreto: true }, base_url: { rotulo: "URL base (opcional)" } } },
  groq: { nombre: "Groq", icono: "speed", ayuda: "Inferencia de muy baja latencia. console.groq.com → API Keys.", campos: { api_key: { rotulo: "API key", secreto: true } } },
  gemini: { nombre: "Google Gemini", icono: "diamond", ayuda: "aistudio.google.com → Get API key. Se usa su endpoint compatible con OpenAI.", campos: { api_key: { rotulo: "API key", secreto: true } } },
  ollama: { nombre: "Ollama (local)", icono: "dns", ayuda: "Modelos y embeddings locales (nomic-embed-text). En producción la URL debe ser pública; la de la instancia (.env) siempre se permite.", campos: { url: { rotulo: "URL", tipo: "url" } } },
  retell: { nombre: "Retell AI (voz)", icono: "call", ayuda: "Motor de voz: STT, TTS, turnos y telefonía. dashboard.retellai.com → API Keys. El webhook y el WebSocket se configuran solos al publicar cada agente.", campos: { api_key: { rotulo: "API key", secreto: true } } },
  meta: { nombre: "Meta (WhatsApp)", icono: "chat", ayuda: "App de Meta como Tech Provider. Necesitas app_id, app_secret (firma de webhooks) y el config_id de Embedded Signup (Facebook Login for Business → Configuraciones).", campos: { app_id: { rotulo: "App ID" }, app_secret: { rotulo: "App secret", secreto: true }, config_id: { rotulo: "Config ID (Embedded Signup)" } } },
  smtp: { nombre: "Correo (SMTP)", icono: "mail", ayuda: "Para pasos de correo en campañas. Gmail/Workspace: smtp.gmail.com:587 con contraseña de aplicación.", campos: { host: { rotulo: "Servidor" }, puerto: { rotulo: "Puerto", tipo: "number" }, usuario: { rotulo: "Usuario" }, clave: { rotulo: "Contraseña", secreto: true }, remitente: { rotulo: "Remitente", tipo: "email" } } },
  calcom: { nombre: "Cal.com", icono: "event", ayuda: "Agenda real en la herramienta agendar_cita. cal.com → Settings → Developer → API keys; el event type id está en la URL del evento.", campos: { api_key: { rotulo: "API key", secreto: true }, event_type_id: { rotulo: "Event type ID" } } },
  hubspot: { nombre: "HubSpot", icono: "hub", ayuda: "Token de una app privada (Settings → Integrations → Private apps) para sincronizar contactos vía webhooks o herramientas API.", campos: { token: { rotulo: "Token de app privada", secreto: true } } },
};
const PROBABLES = new Set(["anthropic", "openai", "groq", "gemini", "ollama", "retell", "smtp", "meta"]);

function TarjetaIntegracion({ integ, onGuardado }: { integ: Integracion; onGuardado: () => void }) {
  const avisar = useAvisos();
  const info = INFO[integ.tipo] ?? { nombre: integ.tipo, icono: "extension", ayuda: "", campos: Object.fromEntries(Object.keys(integ.valores).map((k) => [k, { rotulo: k }])) };
  const inicial = () => Object.fromEntries(Object.entries(info.campos).map(([k, c]) => [k, c.secreto ? "" : String(integ.valores[k] ?? "")]));
  const [valores, setValores] = useState<Record<string, string>>(inicial);
  const [guardando, setGuardando] = useState(false);
  const [prueba, setPrueba] = useState<{ ok: boolean; detalle: string } | null>(null);
  const [probando, setProbando] = useState(false);

  const guardar = async () => {
    setGuardando(true);
    try {
      const cuerpo: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(valores)) {
        if (info.campos[k]?.secreto && !v) continue;
        cuerpo[k] = info.campos[k]?.tipo === "number" && v ? Number(v) : v;
      }
      await api.put(`/api/integraciones/${integ.tipo}`, cuerpo);
      avisar(`${info.nombre} guardado`);
      onGuardado();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setGuardando(false);
    }
  };
  const probar = async () => {
    setProbando(true);
    try {
      setPrueba(await api.post(`/api/integraciones/${integ.tipo}/probar`));
    } catch (e) {
      setPrueba({ ok: false, detalle: (e as Error).message });
    } finally {
      setProbando(false);
    }
  };

  return (
    <Tarjeta
      titulo={info.nombre}
      icono={info.icono}
      acciones={integ.configurada
        ? <Insignia tono="ok" punto>{integ.origen === "instancia" ? "Desde la instancia" : "Configurada"}</Insignia>
        : <Insignia>Sin configurar</Insignia>}
    >
      <div className="pila">
        <p className="chico tenue" style={{ margin: 0 }}>{info.ayuda}</p>
        {Object.entries(info.campos).map(([k, c]) => (
          <Campo key={k} etiqueta={c.rotulo} ayuda={c.secreto && integ.valores[k] ? `Guardada: ${integ.valores[k]} · vacío = conservar` : undefined}>
            <input
              type={c.secreto ? "password" : c.tipo ?? "text"}
              value={valores[k] ?? ""}
              autoComplete="off"
              placeholder={c.secreto && integ.valores[k] ? String(integ.valores[k]) : ""}
              onChange={(e) => setValores({ ...valores, [k]: e.target.value })}
            />
          </Campo>
        ))}
        {prueba && <Banner tono={prueba.ok ? "ok" : "error"} icono={prueba.ok ? "check_circle" : "error"}>{prueba.detalle}</Banner>}
        <div className="acciones">
          <Boton variante="primario" chico cargando={guardando} onClick={guardar}>Guardar</Boton>
          {PROBABLES.has(integ.tipo) && <Boton chico icono="network_check" cargando={probando} onClick={probar}>Probar</Boton>}
        </div>
      </div>
    </Tarjeta>
  );
}

export function Integraciones() {
  const { datos, cargando, error, recargar } = useCarga<Integracion[]>(() => api.get("/api/integraciones"), []);
  if (cargando && !datos) return <Cargando />;
  if (error) return <Banner tono="error" icono="error">{error}</Banner>;
  return (
    <div className="pila">
      <Banner icono="lock">
        Las credenciales se guardan cifradas y nunca se muestran completas. Si un campo viene “desde la instancia”, se usa
        el valor del servidor (.env) hasta que configures uno propio para este espacio.
      </Banner>
      <div className="rejilla c2" style={{ alignItems: "start" }}>
        {(datos ?? []).map((i) => <TarjetaIntegracion key={i.tipo} integ={i} onGuardado={recargar} />)}
      </div>
    </div>
  );
}

// ───────── API y MCP ─────────

interface ClaveApi { id: number; nombre: string; prefijo: string; rol: string; ultimo_uso: string | null; creado: string }

const HERRAMIENTAS_MCP = [
  ["metricas", "KPIs del espacio"], ["listar_llamadas", "Llamadas recientes con resultado y resumen"],
  ["leads_calificados", "Contactos con conversaciones exitosas"], ["listar_conversaciones", "Conversaciones del Inbox"],
  ["ver_conversacion", "Transcript y análisis"], ["buscar_contactos", "Búsqueda de contactos"],
  ["listar_agentes", "Agentes y versión publicada"], ["listar_secuencias", "Campañas y su estado"],
  ["crear_contacto", "Escritura con vista previa → confirmar"], ["inscribir_en_secuencia", "Escritura con vista previa → confirmar"],
  ["editar_instrucciones_agente", "Cambia el borrador del prompt (vista previa → confirmar)"],
];

export function ApiMcp() {
  const avisar = useAvisos();
  const { datos, cargando, recargar } = useCarga<ClaveApi[]>(() => api.get("/api/claves-api"), []);
  const [nueva, setNueva] = useState(false);
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState("editor");
  const [creada, setCreada] = useState<string | null>(null);
  const origen = window.location.origin;

  const crear = async () => {
    try {
      const r = await api.post<{ clave: string }>("/api/claves-api", { nombre, rol });
      setCreada(r.clave);
      setNueva(false);
      setNombre("");
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const borrar = async (c: ClaveApi) => {
    if (!confirm(`¿Revocar la clave "${c.nombre}"? Las integraciones que la usen dejarán de funcionar.`)) return;
    await api.del(`/api/claves-api/${c.id}`);
    recargar();
  };
  const comando = `claude mcp add --transport http platzito ${origen}/mcp --header "Authorization: Bearer ${creada ?? "pz_…"}"`;
  const jsonMcp = JSON.stringify({ mcpServers: { platzito: { type: "http", url: `${origen}/mcp`, headers: { Authorization: `Bearer ${creada ?? "pz_…"}` } } } }, null, 2);

  return (
    <div className="pila">
      {creada && (
        <Banner tono="ok" icono="key">
          <div className="pila c">
            <b>Copia tu clave ahora: no se vuelve a mostrar.</b>
            <div className="fila"><code className="crece trunc">{creada}</code><Boton chico icono="content_copy" onClick={() => copiar(creada, avisar)}>Copiar</Boton></div>
          </div>
        </Banner>
      )}
      <Tarjeta titulo="Claves de API" icono="key" acciones={<Boton variante="primario" chico icono="add" onClick={() => setNueva(true)}>Nueva clave</Boton>}>
        {cargando && !datos ? <Cargando /> : (datos ?? []).length === 0 ? <p className="tenue">Sin claves. Úsalas en la API REST (encabezado X-Api-Key) o en el servidor MCP.</p> : (
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Nombre</th><th>Prefijo</th><th>Rol</th><th>Último uso</th><th>Creada</th><th /></tr></thead>
              <tbody>
                {(datos ?? []).map((c) => (
                  <tr key={c.id}>
                    <td>{c.nombre}</td><td className="mono">{c.prefijo}_…</td><td><Insignia>{c.rol}</Insignia></td>
                    <td className="chico">{fmt.relativa(c.ultimo_uso)}</td><td className="chico">{fmt.fecha(c.creado)}</td>
                    <td><Boton chico variante="texto" icono="delete" onClick={() => borrar(c)} aria-label="Revocar" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>
      <Tarjeta titulo="Servidor MCP" icono="hub">
        <div className="pila">
          <p className="tenue" style={{ margin: 0 }}>
            Conecta Claude (u otro agente compatible con MCP) para consultar métricas, leads y conversaciones, y operar
            campañas. Las escrituras devuelven primero una vista previa y solo se aplican con <code>confirmar: true</code>.
          </p>
          <div className="pila c">
            <span className="chico tenue">Endpoint</span>
            <div className="fila"><code className="crece">{origen}/mcp</code><Boton chico icono="content_copy" onClick={() => copiar(`${origen}/mcp`, avisar)} aria-label="Copiar" /></div>
            <span className="chico tenue">Encabezado</span>
            <code>Authorization: Bearer pz_…</code>
          </div>
          <div className="pila c">
            <div className="fila e"><span className="chico tenue">Claude Code</span><Boton chico icono="content_copy" onClick={() => copiar(comando, avisar)}>Copiar</Boton></div>
            <pre className="tarjeta plana">{comando}</pre>
          </div>
          <div className="pila c">
            <div className="fila e"><span className="chico tenue">Configuración JSON (.mcp.json)</span><Boton chico icono="content_copy" onClick={() => copiar(jsonMcp, avisar)}>Copiar</Boton></div>
            <pre className="tarjeta plana">{jsonMcp}</pre>
          </div>
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Herramienta</th><th>Qué hace</th></tr></thead>
              <tbody>{HERRAMIENTAS_MCP.map(([n, d]) => <tr key={n}><td className="mono">{n}</td><td>{d}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </Tarjeta>
      {nueva && (
        <Modal titulo="Nueva clave de API" onCerrar={() => setNueva(false)} pie={<><Boton onClick={() => setNueva(false)}>Cancelar</Boton><Boton variante="primario" disabled={!nombre.trim()} onClick={crear}>Crear</Boton></>}>
          <Campo etiqueta="Nombre" ayuda="Para recordar dónde la usas"><input type="text" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
          <Campo etiqueta="Permisos">
            <select value={rol} onChange={(e) => setRol(e.target.value)}>
              <option value="lector">Lector (solo lectura)</option>
              <option value="operador">Operador</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </Campo>
        </Modal>
      )}
    </div>
  );
}

// ───────── Webhooks ─────────

export const TIPOS_EVENTO = [
  "*", "conversacion.cerrada", "conversacion.analizada", "conversacion.escalada", "mensaje.recibido", "llamada.terminada",
  "llamada.analizada", "cita.agendada", "contacto.actualizado", "contacto.baja", "secuencia.inscripcion_terminada",
  "secuencia.pausada", "linea.calidad",
];

interface Suscripcion { id: number; url: string; eventos: string[]; activa: boolean; secreto: string; creado: string }
interface Entrega { id: number; evento: string; estado: string; intentos: number; respuesta: string; creado: string }

const SNIPPET_FIRMA = `// Node.js: verificar x-platzito-firma
import crypto from "node:crypto";

function firmaValida(secreto, cuerpoCrudo, encabezado) {
  const partes = Object.fromEntries(encabezado.split(",").map((p) => p.split("=")));
  const esperado = crypto.createHmac("sha256", secreto)
    .update(\`\${partes.t}.\${cuerpoCrudo}\`).digest("hex");
  const vigente = Math.abs(Date.now() / 1000 - Number(partes.t)) < 300;
  return vigente && crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(partes.v1));
}`;

function ModalWebhook({ sub, onCerrar, onListo }: { sub: Suscripcion | null; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [url, setUrl] = useState(sub?.url ?? "");
  const [eventos, setEventos] = useState<string[]>(sub?.eventos ?? ["*"]);
  const [activa, setActiva] = useState(sub?.activa ?? true);
  const alternar = (e: string) => {
    if (e === "*") setEventos(eventos.includes("*") ? [] : ["*"]);
    else setEventos(eventos.includes(e) ? eventos.filter((x) => x !== e) : [...eventos.filter((x) => x !== "*"), e]);
  };
  const guardar = async () => {
    try {
      if (sub) await api.patch(`/api/webhooks/${sub.id}`, { url, eventos, activa });
      else await api.post("/api/webhooks", { url, eventos, activa });
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  return (
    <Modal titulo={sub ? "Editar webhook" : "Nuevo webhook"} onCerrar={onCerrar} pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!/^https?:\/\//.test(url) || !eventos.length} onClick={guardar}>Guardar</Boton></>}>
      <Campo etiqueta="URL de destino" ayuda="Debe ser pública (HTTPS recomendado)"><input type="url" value={url} onChange={(e) => setUrl(e.target.value.trim())} /></Campo>
      <Campo etiqueta="Eventos">
        <div className="rejilla c2" style={{ gap: "var(--gap-8)" }}>
          {TIPOS_EVENTO.map((e) => (
            <Check key={e} valor={eventos.includes(e)} onCambio={() => alternar(e)}><span className="mono chico">{e === "*" ? "* (todos)" : e}</span></Check>
          ))}
        </div>
      </Campo>
      <Check valor={activa} onCambio={setActiva}>Activo</Check>
    </Modal>
  );
}

function Entregas({ sub, onCerrar }: { sub: Suscripcion; onCerrar: () => void }) {
  const { datos, cargando } = useCarga<Entrega[]>(() => api.get(`/api/webhooks/${sub.id}/entregas`), [sub.id]);
  return (
    <Modal grande titulo="Entregas recientes" onCerrar={onCerrar}>
      {cargando ? <Cargando /> : (datos ?? []).length === 0 ? <p className="tenue">Sin entregas todavía.</p> : (
        <div className="tabla-env">
          <table className="tabla">
            <thead><tr><th>Evento</th><th>Estado</th><th className="num">Intentos</th><th>Respuesta</th><th>Fecha</th></tr></thead>
            <tbody>
              {(datos ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="mono chico">{e.evento}</td>
                  <td><Insignia tono={e.estado === "ok" ? "ok" : e.estado === "fallida" ? "error" : "aviso"}>{e.estado}</Insignia></td>
                  <td className="num">{e.intentos}</td>
                  <td className="chico mono trunc" style={{ maxWidth: 280 }} title={e.respuesta}>{e.respuesta}</td>
                  <td className="chico">{fmt.fecha(e.creado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export function Webhooks() {
  const avisar = useAvisos();
  const { datos, cargando, recargar } = useCarga<Suscripcion[]>(() => api.get("/api/webhooks"), []);
  const [editar, setEditar] = useState<Suscripcion | null | "nuevo">(null);
  const [entregas, setEntregas] = useState<Suscripcion | null>(null);
  const [verSecreto, setVerSecreto] = useState<number | null>(null);
  const [probando, setProbando] = useState<number | null>(null);

  const probar = async (s: Suscripcion) => {
    setProbando(s.id);
    try {
      const r = await api.post<{ ok: boolean; respuesta: string }>(`/api/webhooks/${s.id}/probar`);
      avisar(r.ok ? `Entregado: ${r.respuesta}` : `Falló: ${r.respuesta}`, !r.ok);
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setProbando(null);
    }
  };
  const borrar = async (s: Suscripcion) => {
    if (!confirm(`¿Eliminar el webhook a ${s.url}?`)) return;
    await api.del(`/api/webhooks/${s.id}`);
    recargar();
  };

  return (
    <div className="pila">
      <Tarjeta titulo="Webhooks salientes" icono="webhook" acciones={<Boton variante="primario" chico icono="add" onClick={() => setEditar("nuevo")}>Nuevo webhook</Boton>}>
        {cargando && !datos ? <Cargando /> : (datos ?? []).length === 0 ? (
          <Vacio icono="webhook" titulo="Sin webhooks">Envía conversaciones analizadas, llamadas, citas y bajas a tu CRM, Zapier, n8n o tu backend.</Vacio>
        ) : (
          <div className="pila">
            {(datos ?? []).map((s) => (
              <div key={s.id} className="tarjeta plana pila c">
                <div className="fila e">
                  <div className="crece">
                    <div className="mono trunc">{s.url}</div>
                    <div className="fila" style={{ gap: "var(--gap-4)", marginTop: 4 }}>
                      {s.activa ? <Insignia tono="ok">Activo</Insignia> : <Insignia>Pausado</Insignia>}
                      {s.eventos.map((e) => <Insignia key={e}>{e}</Insignia>)}
                    </div>
                  </div>
                  <div className="acciones">
                    <Boton chico icono="send" cargando={probando === s.id} onClick={() => probar(s)}>Probar</Boton>
                    <Boton chico icono="history" onClick={() => setEntregas(s)}>Entregas</Boton>
                    <Boton chico variante="texto" icono="edit" onClick={() => setEditar(s)} aria-label="Editar" />
                    <Boton chico variante="texto" icono="delete" onClick={() => borrar(s)} aria-label="Eliminar" />
                  </div>
                </div>
                <div className="fila chico">
                  <span className="tenue">Secreto:</span>
                  <code>{verSecreto === s.id ? s.secreto : "whsec_••••••••"}</code>
                  <Boton chico variante="texto" icono={verSecreto === s.id ? "visibility_off" : "visibility"} onClick={() => setVerSecreto(verSecreto === s.id ? null : s.id)} aria-label="Mostrar secreto" />
                  <Boton chico variante="texto" icono="content_copy" onClick={() => copiar(s.secreto, avisar)} aria-label="Copiar secreto" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Tarjeta>
      <Tarjeta titulo="Verificar la firma" icono="verified_user">
        <div className="pila c">
          <p className="tenue" style={{ margin: 0 }}>
            Cada entrega lleva <code>x-platzito-firma: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> donde v1 = HMAC-SHA256(secreto, <code>{"${t}.${cuerpo}"}</code>).
            Reintentos con espera creciente (1, 5, 30, 120 y 720 min).
          </p>
          <pre className="tarjeta plana">{SNIPPET_FIRMA}</pre>
        </div>
      </Tarjeta>
      {editar && <ModalWebhook sub={editar === "nuevo" ? null : editar} onCerrar={() => setEditar(null)} onListo={() => { setEditar(null); recargar(); }} />}
      {entregas && <Entregas sub={entregas} onCerrar={() => setEntregas(null)} />}
    </div>
  );
}

// ───────── Eventos ─────────

interface Evento { id: number; tipo: string; datos: Record<string, unknown>; creado: string }

export function Eventos() {
  const [tipo, setTipo] = useState("");
  const { datos, cargando, recargar } = useCarga<Evento[]>(() => api.get(`/api/eventos${qs({ tipo, limite: 200 })}`), [tipo]);
  const [abierto, setAbierto] = useState<number | null>(null);
  return (
    <Tarjeta titulo="Eventos recientes" icono="receipt_long" acciones={
      <>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} style={{ width: 260 }} aria-label="Tipo de evento">
          <option value="">Todos los tipos</option>
          {TIPOS_EVENTO.filter((t) => t !== "*").map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Boton chico icono="refresh" onClick={recargar} aria-label="Recargar" />
      </>
    }>
      {cargando && !datos ? <Cargando /> : (datos ?? []).length === 0 ? <p className="tenue">Sin eventos.</p> : (
        <div className="tabla-env">
          <table className="tabla">
            <thead><tr><th>Tipo</th><th>Fecha</th><th /></tr></thead>
            <tbody>
              {(datos ?? []).map((e) => (
                <Fragment key={e.id}>
                  <tr className="clic" onClick={() => setAbierto(abierto === e.id ? null : e.id)}>
                    <td className="mono">{e.tipo}</td>
                    <td className="chico">{fmt.fecha(e.creado)}</td>
                    <td className="num"><Icono n={abierto === e.id ? "expand_less" : "expand_more"} /></td>
                  </tr>
                  {abierto === e.id && (
                    <tr><td colSpan={3}><pre className="chico">{JSON.stringify(e.datos, null, 2)}</pre></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Tarjeta>
  );
}
