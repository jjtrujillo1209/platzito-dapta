// Pestaña Voz: configuración que se espeja en Retell, prueba en el navegador y llamada de prueba.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Numero } from "../tipos";
import { Ayuda, Deslizador, Num, type PropsPestana } from "./agente-comun";
import { Banner, Boton, Campo, Check, Icono, Insignia, ListaTextos, Modal, Tarjeta, fmt, useAvisos, useCarga } from "./ui";

interface Voz { id: string; nombre: string; proveedor: string; genero: string; acento: string; muestra: string }
const IDIOMAS = [
  ["es-419", "Español (Latinoamérica)"], ["es-ES", "Español (España)"], ["en-US", "Inglés (EE. UU.)"],
  ["pt-BR", "Portugués (Brasil)"], ["multi", "Multilingüe"],
];
const SONIDOS = ["", "coffee-shop", "convention-hall", "summer-outdoor", "mountain-outdoor", "static-noise", "call-center"];

function LlamadaWeb({ agenteId, onCerrar }: { agenteId: number; onCerrar: () => void }) {
  const [estado, setEstado] = useState<"conectando" | "en_curso" | "terminada" | "error">("conectando");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState<{ role: string; content: string }[]>([]);
  const [hablando, setHablando] = useState(false);
  const cliente = useRef<{ stopCall: () => void } | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const { access_token } = await api.post<{ access_token: string }>(`/api/agentes/${agenteId}/llamada-web`, {});
        const { RetellWebClient } = await import("retell-client-js-sdk");
        if (cancelado) return;
        const c = new RetellWebClient();
        cliente.current = c;
        c.on("call_started", () => setEstado("en_curso"));
        c.on("call_ended", () => setEstado("terminada"));
        c.on("agent_start_talking", () => setHablando(true));
        c.on("agent_stop_talking", () => setHablando(false));
        c.on("update", (u: { transcript?: { role: string; content: string }[] }) => u.transcript && setTranscript(u.transcript));
        c.on("error", (e: unknown) => {
          setError(String((e as Error)?.message ?? e));
          setEstado("error");
          c.stopCall();
        });
        await c.startCall({ accessToken: access_token });
      } catch (e) {
        setError((e as Error).message);
        setEstado("error");
      }
    })();
    return () => {
      cancelado = true;
      cliente.current?.stopCall();
    };
  }, [agenteId]);

  const colgar = () => { cliente.current?.stopCall(); setEstado("terminada"); };
  return (
    <Modal titulo="Prueba de voz en el navegador" onCerrar={() => { colgar(); onCerrar(); }} pie={
      estado === "en_curso" || estado === "conectando"
        ? <Boton variante="peligro" icono="call_end" onClick={colgar}>Colgar</Boton>
        : <Boton onClick={onCerrar}>Cerrar</Boton>
    }>
      <div className="fila">
        {estado === "conectando" && <Insignia tono="info"><Icono n="progress_activity" className="giro" /> Conectando…</Insignia>}
        {estado === "en_curso" && <Insignia tono="ok" punto>{hablando ? "El agente está hablando" : "Escuchando"}</Insignia>}
        {estado === "terminada" && <Insignia>Llamada terminada</Insignia>}
        {estado === "error" && <Insignia tono="error">Error</Insignia>}
      </div>
      {error && <Banner tono="error">{error}</Banner>}
      <Ayuda>Usa el borrador actual para el prompt y las herramientas; la voz y los tiempos de turno son los de la última versión sincronizada con Retell. Permite el micrófono cuando el navegador lo pida.</Ayuda>
      <div className="chat tarjeta plana" style={{ minHeight: 200, maxHeight: 360 }}>
        {transcript.length === 0 && <span className="tenue chico">El transcript aparece aquí en vivo.</span>}
        {transcript.map((t, i) => (
          <div key={i} className={`burbuja ${t.role === "agent" ? "saliente" : "entrante"}`}>{t.content}</div>
        ))}
      </div>
    </Modal>
  );
}

function LlamadaPrueba({ agenteId, onCerrar }: { agenteId: number; onCerrar: () => void }) {
  const avisar = useAvisos();
  const numeros = useCarga(() => api.get<Numero[]>("/api/numeros"));
  const [telefono, setTelefono] = useState("");
  const [nombre, setNombre] = useState("");
  const [numeroId, setNumeroId] = useState<number | "">("");
  const [cargando, setCargando] = useState(false);
  const llamar = async () => {
    setCargando(true);
    try {
      await api.post(`/api/agentes/${agenteId}/llamada-prueba`, { telefono, numero_id: numeroId, nombre });
      avisar("Llamando… el resultado aparecerá en Llamadas.");
      onCerrar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setCargando(false);
    }
  };
  const activos = (numeros.datos ?? []).filter((n) => n.activo);
  return (
    <Modal titulo="Llamada de prueba" onCerrar={onCerrar} pie={<>
      <Boton onClick={onCerrar}>Cancelar</Boton>
      <Boton variante="primario" icono="call" disabled={!telefono || !numeroId} cargando={cargando} onClick={llamar}>Llamar</Boton>
    </>}>
      <Banner icono="info">Usa la versión publicada del agente. Llamará desde el número elegido al teléfono que escribas.</Banner>
      <Campo etiqueta="Teléfono a llamar"><input type="tel" value={telefono} placeholder="+57 300 123 4567" onChange={(e) => setTelefono(e.target.value)} /></Campo>
      <Campo etiqueta="Nombre (para {{nombre}})"><input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
      <Campo etiqueta="Llamar desde">
        <select value={numeroId} onChange={(e) => setNumeroId(Number(e.target.value) || "")}>
          <option value="">Elige un número…</option>
          {activos.map((n) => <option key={n.id} value={n.id}>{n.numero} {n.etiqueta && `· ${n.etiqueta}`}{n.importado_retell ? "" : " (no importado a Retell)"}</option>)}
        </select>
      </Campo>
      {numeros.datos && activos.length === 0 && <Banner tono="aviso">No tienes números de salida. Agrégalos en Canales → Voz.</Banner>}
    </Modal>
  );
}

export default function PestanaVoz({ agente, cfg, setCfg, editable }: PropsPestana) {
  const opciones = useCarga(() => api.get<{ voces: Voz[] }>("/api/agentes/opciones"));
  const [modal, setModal] = useState<"" | "web" | "telefono">("");
  const v = cfg.voz;
  const setV = (c: Partial<typeof v>) => setCfg({ ...cfg, voz: { ...v, ...c } });
  const voces = opciones.datos?.voces ?? [];
  const vozActual = voces.find((x) => x.id === v.voz_id);
  const tieneColgar = cfg.herramientas.some((h) => h.tipo === "colgar" && h.activa);

  return (
    <div className="pila">
      <Tarjeta titulo="Estado en Retell" icono="settings_phone" acciones={<>
        <Boton icono="mic" variante="primario" onClick={() => setModal("web")}>Probar voz en el navegador</Boton>
        <Boton icono="call" disabled={!agente.publicado} title={agente.publicado ? "" : "Publica primero"} onClick={() => setModal("telefono")}>Llamada de prueba</Boton>
      </>}>
        {agente.retell_agent_id ? (
          <div className="fila">
            <Insignia tono="ok" punto>Sincronizado</Insignia>
            <span className="mono chico tenue">{agente.retell_agent_id}</span>
            <span className="chico tenue">· {fmt.relativa(agente.retell_sincronizado)}</span>
          </div>
        ) : (
          <Banner tono="aviso">Este agente aún no existe en Retell. Al publicar (con Retell configurado en Ajustes → Integraciones) se crea su espejo de voz.</Banner>
        )}
        {!tieneColgar && <div style={{ marginTop: 8 }}><Banner tono="aviso">El agente no tiene la herramienta «Colgar» activa: en llamadas solo colgará por la guarda de despedida o por silencio.</Banner></div>}
      </Tarjeta>

      <Tarjeta titulo="Voz" icono="record_voice_over">
        <div className="rejilla c2">
          <Campo etiqueta="Voz" ayuda={vozActual ? `${vozActual.proveedor} · ${vozActual.genero ?? ""} ${vozActual.acento ?? ""}` : voces.length ? "" : "Configura Retell para ver el catálogo; puedes escribir el ID."}>
            {voces.length ? (
              <select value={v.voz_id} disabled={!editable} onChange={(e) => setV({ voz_id: e.target.value })}>
                {!vozActual && <option value={v.voz_id}>{v.voz_id}</option>}
                {voces.map((x) => <option key={x.id} value={x.id}>{x.nombre} · {x.proveedor} {x.acento ? `(${x.acento})` : ""}</option>)}
              </select>
            ) : (
              <input type="text" className="mono" value={v.voz_id} disabled={!editable} onChange={(e) => setV({ voz_id: e.target.value })} />
            )}
          </Campo>
          <Campo etiqueta="Idioma">
            <select value={v.idioma} disabled={!editable} onChange={(e) => setV({ idioma: e.target.value })}>
              {IDIOMAS.map(([id, t]) => <option key={id} value={id}>{t}</option>)}
            </select>
          </Campo>
        </div>
        {vozActual?.muestra && <audio controls src={vozActual.muestra} style={{ marginTop: 12, width: "100%" }} />}
        <div className="rejilla c3" style={{ marginTop: "var(--gap-16)" }}>
          <Campo etiqueta="Velocidad"><Deslizador valor={v.velocidad} min={0.5} max={2} paso={0.05} disabled={!editable} onCambio={(x) => setV({ velocidad: x })} /></Campo>
          <Campo etiqueta="Expresividad"><Deslizador valor={v.temperatura_voz} min={0} max={2} paso={0.05} disabled={!editable} onCambio={(x) => setV({ temperatura_voz: x })} /></Campo>
          <Campo etiqueta="Volumen"><Deslizador valor={v.volumen} min={0} max={2} paso={0.05} disabled={!editable} onCambio={(x) => setV({ volumen: x })} /></Campo>
        </div>
        <Campo etiqueta="Sonido ambiente" className="" ayuda="Da naturalidad; déjalo vacío para silencio.">
          <select value={v.sonido_ambiente ?? ""} disabled={!editable} onChange={(e) => setV({ sonido_ambiente: e.target.value || null })}>
            {SONIDOS.map((s) => <option key={s} value={s}>{s || "Ninguno"}</option>)}
          </select>
        </Campo>
      </Tarjeta>

      <Tarjeta titulo="Turnos y escucha" icono="hearing">
        <div className="rejilla c2">
          <Campo etiqueta="Sensibilidad a interrupciones" ayuda="Alto = el contacto puede interrumpir fácilmente">
            <Deslizador valor={v.sensibilidad_interrupcion} min={0} max={1} paso={0.05} disabled={!editable} onCambio={(x) => setV({ sensibilidad_interrupcion: x })} />
          </Campo>
          <Campo etiqueta="Rapidez de respuesta" ayuda="Alto = responde apenas el contacto calla">
            <Deslizador valor={v.reactividad} min={0} max={1} paso={0.05} disabled={!editable} onCambio={(x) => setV({ reactividad: x })} />
          </Campo>
        </div>
        <div className="pila c" style={{ marginTop: "var(--gap-12)" }}>
          <Check valor={v.backchannel} onCambio={(x) => editable && setV({ backchannel: x })}>Backchannel («ajá», «claro») mientras el contacto habla</Check>
          <Check valor={v.dtmf} onCambio={(x) => editable && setV({ dtmf: x })}>Permitir que el contacto marque dígitos</Check>
        </div>
        <Campo etiqueta="Palabras clave a reconocer mejor" ayuda="Marcas, productos, nombres propios." className="">
          <ListaTextos valor={v.palabras_clave} onCambio={(x) => editable && setV({ palabras_clave: x })} placeholder="Platzi" />
        </Campo>
      </Tarjeta>

      <Tarjeta titulo="Llamada" icono="timer">
        <div className="rejilla c4">
          <Campo etiqueta="Colgar tras silencio (s)"><Num valor={v.fin_silencio_ms / 1000} min={10} max={600} disabled={!editable} onCambio={(x) => setV({ fin_silencio_ms: x * 1000 })} /></Campo>
          <Campo etiqueta="Duración máxima (min)"><Num valor={v.duracion_max_ms / 60000} min={1} max={120} disabled={!editable} onCambio={(x) => setV({ duracion_max_ms: x * 60000 })} /></Campo>
          <Campo etiqueta="Recordar tras silencio (s)"><Num valor={v.recordatorio_ms / 1000} min={1} max={60} disabled={!editable} onCambio={(x) => setV({ recordatorio_ms: x * 1000 })} /></Campo>
          <Campo etiqueta="Máx. recordatorios"><Num valor={v.recordatorio_max} min={0} max={5} disabled={!editable} onCambio={(x) => setV({ recordatorio_max: x })} /></Campo>
        </div>
        <Campo etiqueta="Número de transferencia" ayuda="A dónde transferir si pide un humano o usa «Transferir llamada»." className="">
          <input type="tel" value={v.numero_transferencia} disabled={!editable} placeholder="+5716000000" onChange={(e) => setV({ numero_transferencia: e.target.value })} />
        </Campo>
      </Tarjeta>

      <Tarjeta titulo="Buzón de voz" icono="voicemail">
        <div className="pila">
          <Check valor={v.buzon.detectar} onCambio={(x) => editable && setV({ buzon: { ...v.buzon, detectar: x } })}>Detectar buzón de voz</Check>
          {v.buzon.detectar && (
            <>
              <Campo etiqueta="Al detectar buzón">
                <select value={v.buzon.accion} disabled={!editable} onChange={(e) => setV({ buzon: { ...v.buzon, accion: e.target.value as "colgar" | "mensaje" } })}>
                  <option value="colgar">Colgar</option>
                  <option value="mensaje">Dejar un mensaje</option>
                </select>
              </Campo>
              {v.buzon.accion === "mensaje" && (
                <Campo etiqueta="Mensaje">
                  <textarea rows={3} value={v.buzon.mensaje} disabled={!editable} onChange={(e) => setV({ buzon: { ...v.buzon, mensaje: e.target.value } })}
                    placeholder="Hola {{primer_nombre}}, te llamamos de Platzi. Te escribiremos por WhatsApp." />
                </Campo>
              )}
            </>
          )}
        </div>
      </Tarjeta>

      {modal === "web" && <LlamadaWeb agenteId={agente.id} onCerrar={() => setModal("")} />}
      {modal === "telefono" && <LlamadaPrueba agenteId={agente.id} onCerrar={() => setModal("")} />}
    </div>
  );
}
