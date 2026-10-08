// Pestaña WhatsApp de Canales: líneas conectadas, salud y conexión (Embedded Signup o manual).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useSesion } from "../sesion";
import type { Agente, Linea } from "../tipos";
import { Banner, Boton, Campo, Cargando, Check, Icono, Insignia, Modal, Tarjeta, Vacio, fmt, useAvisos, useCarga, type TonoInsignia } from "./ui";

const TONO_CALIDAD: Record<string, { tono: TonoInsignia; texto: string }> = {
  GREEN: { tono: "ok", texto: "Calidad alta" },
  YELLOW: { tono: "aviso", texto: "Calidad media" },
  RED: { tono: "error", texto: "Calidad baja" },
  UNKNOWN: { tono: "", texto: "Calidad desconocida" },
};

interface ConfigSignup {
  app_id: string | null;
  config_id: string | null;
  graph_version: string;
  webhook_url: string;
  verify_token: string;
  listo: boolean;
}

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

function cargarSdkFacebook(appId: string, version: string): Promise<void> {
  return new Promise((resolver) => {
    if (window.FB) {
      resolver();
      return;
    }
    window.fbAsyncInit = () => {
      window.FB.init({ appId, version, xfbml: false, autoLogAppEvents: true });
      resolver();
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/es_LA/sdk.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    document.body.appendChild(s);
  });
}

function SaludLinea({ linea, onCerrar }: { linea: Linea; onCerrar: () => void }) {
  const { datos, cargando } = useCarga<{ envios_por_dia: { dia: string; envios: number }[]; dias_calentamiento: number }>(
    () => api.get(`/api/lineas/${linea.id}/salud`), [linea.id]);
  const max = Math.max(1, ...(datos?.envios_por_dia.map((d) => d.envios) ?? [1]));
  return (
    <Modal titulo={`Salud de ${linea.numero_visible || linea.phone_number_id}`} onCerrar={onCerrar}>
      {cargando || !datos ? <Cargando /> : (
        <>
          <div className="fila">
            <Insignia tono={TONO_CALIDAD[linea.calidad]?.tono} punto>{TONO_CALIDAD[linea.calidad]?.texto}</Insignia>
            <Insignia>{linea.tier}</Insignia>
            <Insignia tono="info">{datos.dias_calentamiento} días desde el alta</Insignia>
          </div>
          <div className="chico tenue">Envíos proactivos por día (últimos 14 días)</div>
          {datos.envios_por_dia.length === 0 ? <p className="tenue">Sin envíos todavía.</p> : (
            <div className="barras" aria-label="Envíos por día">
              {datos.envios_por_dia.map((d) => (
                <div key={d.dia} className="b" style={{ height: `${(d.envios / max) * 100}%` }} title={`${d.dia}: ${d.envios}`} />
              ))}
            </div>
          )}
          <p className="chico tenue">
            El tope diario sube solo: 50 los primeros 3 días, 150 hasta el día 7, 400 hasta el 14 y luego el doble del
            mejor día reciente (sin pasar el 80% del tier). Con calidad media se reduce a la mitad y con calidad baja se
            pausa el marketing automáticamente.
          </p>
        </>
      )}
    </Modal>
  );
}

function TarjetaLinea({ linea, agentes, alCambiar }: { linea: Linea; agentes: Agente[]; alCambiar: () => void }) {
  const avisar = useAvisos();
  const { puede } = useSesion();
  const [tope, setTope] = useState(linea.tope_diario_manual?.toString() ?? "");
  const [sincronizando, setSincronizando] = useState(false);
  const [salud, setSalud] = useState(false);
  const calidad = TONO_CALIDAD[linea.calidad] ?? TONO_CALIDAD.UNKNOWN;
  const uso = linea.tope_24h ? Math.min(1, (linea.enviados_24h ?? 0) / linea.tope_24h) : 0;
  const dias = Math.floor((Date.now() - new Date(linea.calentamiento_desde).getTime()) / 86400000);

  const cambiar = async (cuerpo: Record<string, unknown>) => {
    try {
      await api.patch(`/api/lineas/${linea.id}`, cuerpo);
      alCambiar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const sincronizar = async () => {
    setSincronizando(true);
    try {
      const r = await api.post<{ plantillas: number }>(`/api/lineas/${linea.id}/sincronizar`);
      avisar(`Línea sincronizada · ${r.plantillas} plantillas`);
      alCambiar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setSincronizando(false);
    }
  };
  const desconectar = async () => {
    if (!confirm("¿Desconectar esta línea? Dejará de recibir y enviar mensajes desde Platzito.")) return;
    await api.del(`/api/lineas/${linea.id}`);
    alCambiar();
  };

  return (
    <Tarjeta
      titulo={<span className="fila" style={{ gap: "var(--gap-8)" }}><Icono n="chat" />{linea.numero_visible || linea.phone_number_id}</span>}
      acciones={
        <>
          <Boton chico icono="monitor_heart" onClick={() => setSalud(true)}>Salud</Boton>
          <Boton chico icono="sync" cargando={sincronizando} onClick={sincronizar}>Sincronizar</Boton>
          {puede("admin") && <Boton chico variante="peligro" icono="link_off" onClick={desconectar} aria-label="Desconectar" />}
        </>
      }
    >
      <div className="pila">
        <div className="fila">
          {linea.nombre_verificado && <span style={{ fontWeight: 600 }}>{linea.nombre_verificado}</span>}
          <Insignia tono={calidad.tono} punto>{calidad.texto}</Insignia>
          <Insignia>{linea.tier}</Insignia>
          {linea.estado !== "conectada" && <Insignia tono="error">{linea.estado}</Insignia>}
          {linea.coexistencia && <Insignia tono="info">Coexistencia</Insignia>}
          {dias < 14 && <Insignia tono="aviso">Calentando · día {dias + 1}</Insignia>}
          {linea.marketing_pausado && <Insignia tono="error">Marketing en pausa</Insignia>}
        </div>
        <div className="pila c">
          <div className="fila e chico">
            <span className="tenue">Envíos proactivos últimas 24 h</span>
            <span className="ds-numeric">{fmt.numero(linea.enviados_24h)} / {fmt.numero(linea.tope_24h)}</span>
          </div>
          <div className="barra-h"><span style={{ width: `${uso * 100}%` }} /></div>
        </div>
        <div className="rejilla c2">
          <Campo etiqueta="Agente que responde">
            <select
              value={linea.agente_id ?? ""}
              disabled={!puede("admin")}
              onChange={(e) => cambiar(e.target.value ? { agente_id: Number(e.target.value) } : { quitar_agente: true })}
            >
              <option value="">Sin agente (solo humanos)</option>
              {agentes.map((a) => <option key={a.id} value={a.id}>{a.nombre}{a.publicado ? "" : " (sin publicar)"}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Tope diario manual" ayuda="Vacío = automático">
            <input type="number" min={0} value={tope} disabled={!puede("admin")}
              onChange={(e) => setTope(e.target.value)}
              onBlur={() => tope !== (linea.tope_diario_manual?.toString() ?? "") && cambiar({ tope_diario_manual: Number(tope) || 0 })} />
          </Campo>
        </div>
        <Check valor={linea.marketing_pausado} onCambio={(v) => puede("admin") && cambiar({ marketing_pausado: v })}>
          Pausar plantillas de marketing en esta línea
        </Check>
        <div className="chico tenue mono">phone_number_id {linea.phone_number_id} · WABA {linea.waba_id} · revisada {fmt.relativa(linea.calidad_revisada_en)}</div>
      </div>
      {salud && <SaludLinea linea={linea} onCerrar={() => setSalud(false)} />}
    </Tarjeta>
  );
}

function ConectarWhatsapp({ agentes, onCerrar, onListo }: { agentes: Agente[]; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [modo, setModo] = useState<"signup" | "manual">("signup");
  const { datos: cfg, cargando } = useCarga<ConfigSignup>(() => api.get("/api/whatsapp/config-signup"), []);
  const [coexistencia, setCoexistencia] = useState(false);
  const [pin, setPin] = useState("");
  const [agenteId, setAgenteId] = useState<string>("");
  const [enviando, setEnviando] = useState(false);
  const [manual, setManual] = useState({ phone_number_id: "", waba_id: "", token: "" });
  const sesionMeta = useRef<{ phone_number_id?: string; waba_id?: string }>({});

  useEffect(() => {
    const escuchar = (e: MessageEvent) => {
      try {
        if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
        const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (d?.type === "WA_EMBEDDED_SIGNUP") {
          if (d.event === "FINISH" || d.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || d.event === "FINISH_ONLY_WABA") {
            sesionMeta.current = { phone_number_id: d.data?.phone_number_id, waba_id: d.data?.waba_id };
          } else if (d.event === "CANCEL") {
            avisar(`Registro cancelado${d.data?.current_step ? ` en ${d.data.current_step}` : ""}`, true);
          } else if (d.event === "ERROR") {
            avisar(`Meta reportó un error: ${d.data?.error_message ?? ""}`, true);
          }
        }
      } catch {
        /* mensajes ajenos al registro */
      }
    };
    window.addEventListener("message", escuchar);
    return () => window.removeEventListener("message", escuchar);
  }, [avisar]);

  const agente = agenteId ? Number(agenteId) : null;

  const lanzarSignup = async () => {
    if (!cfg?.app_id || !cfg.config_id) return;
    if (!coexistencia && pin && !/^\d{6}$/.test(pin)) {
      avisar("El PIN debe tener 6 dígitos", true);
      return;
    }
    await cargarSdkFacebook(cfg.app_id, cfg.graph_version);
    window.FB.login(
      (resp: any) => {
        const code = resp?.authResponse?.code;
        if (!code) {
          avisar("No se completó el inicio de sesión con Meta", true);
          return;
        }
        // El evento FINISH puede llegar justo después del callback: esperamos un instante
        setTimeout(async () => {
          const { phone_number_id, waba_id } = sesionMeta.current;
          if (!phone_number_id || !waba_id) {
            avisar("Meta no devolvió el número ni la WABA. Intenta de nuevo o usa la conexión manual.", true);
            return;
          }
          setEnviando(true);
          try {
            await api.post("/api/lineas/embedded-signup", { code, waba_id, phone_number_id, pin, coexistencia, agente_id: agente });
            avisar("Línea de WhatsApp conectada");
            onListo();
          } catch (e) {
            avisar((e as Error).message, true);
          } finally {
            setEnviando(false);
          }
        }, 800);
      },
      {
        config_id: cfg.config_id,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: coexistencia ? "whatsapp_business_app_onboarding" : "", sessionInfoVersion: "3" },
      },
    );
  };

  const conectarManual = async () => {
    setEnviando(true);
    try {
      await api.post("/api/lineas", { ...manual, agente_id: agente });
      avisar("Línea de WhatsApp conectada");
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };

  const selectorAgente = (
    <Campo etiqueta="Agente que responderá" ayuda="Puedes cambiarlo después">
      <select value={agenteId} onChange={(e) => setAgenteId(e.target.value)}>
        <option value="">Ninguno por ahora</option>
        {agentes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
      </select>
    </Campo>
  );

  return (
    <Modal titulo="Conectar WhatsApp" onCerrar={onCerrar} pie={
      <>
        <Boton onClick={onCerrar}>Cancelar</Boton>
        {modo === "signup" ? (
          <Boton variante="primario" icono="login" disabled={!cfg?.listo} cargando={enviando} onClick={lanzarSignup}>Continuar con Meta</Boton>
        ) : (
          <Boton variante="primario" cargando={enviando} disabled={!manual.phone_number_id || !manual.waba_id || manual.token.length < 20} onClick={conectarManual}>Conectar</Boton>
        )}
      </>
    }>
      <div className="pestanas">
        <button className={`pestana ${modo === "signup" ? "activa" : ""}`} onClick={() => setModo("signup")}>Registro con Meta</button>
        <button className={`pestana ${modo === "manual" ? "activa" : ""}`} onClick={() => setModo("manual")}>Token de System User</button>
      </div>
      {cargando || !cfg ? <Cargando /> : modo === "signup" ? (
        <>
          <p className="tenue">
            Conexión directa con Meta (sin intermediarios). Tu cliente inicia sesión con Facebook, elige o crea su
            cuenta de WhatsApp Business y su número. Meta le factura los envíos directamente.
          </p>
          {!cfg.listo && (
            <Banner tono="aviso" icono="warning">
              Falta configurar la app de Meta: {!cfg.app_id && "app_id "}{!cfg.config_id && "config_id (Embedded Signup)"}. Ve a
              Ajustes → Integraciones → Meta.
            </Banner>
          )}
          <Check valor={coexistencia} onCambio={setCoexistencia}>
            Coexistencia: el número ya usa la app WhatsApp Business y debe seguir usándola
          </Check>
          {!coexistencia && (
            <Campo etiqueta="PIN de verificación en dos pasos" ayuda="6 dígitos para registrar el número en la Cloud API">
              <input type="text" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Campo>
          )}
          {selectorAgente}
          <Tarjeta titulo="Webhook en la app de Meta" icono="webhook" className="plana">
            <div className="pila c chico">
              <div>URL de devolución: <code>{cfg.webhook_url}</code></div>
              <div>Token de verificación: <code>{cfg.verify_token}</code></div>
              <div className="tenue">Suscribe los campos messages, smb_message_echoes, message_template_status_update y phone_number_quality_update.</div>
            </div>
          </Tarjeta>
        </>
      ) : (
        <>
          <p className="tenue">Para números de tu propio negocio: usa un token permanente de System User con permisos whatsapp_business_messaging y whatsapp_business_management.</p>
          <Campo etiqueta="Phone number ID"><input type="text" value={manual.phone_number_id} onChange={(e) => setManual({ ...manual, phone_number_id: e.target.value.trim() })} /></Campo>
          <Campo etiqueta="WABA ID"><input type="text" value={manual.waba_id} onChange={(e) => setManual({ ...manual, waba_id: e.target.value.trim() })} /></Campo>
          <Campo etiqueta="Token de acceso" ayuda="Se guarda cifrado"><input type="password" value={manual.token} onChange={(e) => setManual({ ...manual, token: e.target.value.trim() })} /></Campo>
          {selectorAgente}
        </>
      )}
    </Modal>
  );
}

export default function CanalWhatsapp() {
  const { puede } = useSesion();
  const lineas = useCarga<Linea[]>(() => api.get("/api/lineas"), []);
  const agentes = useCarga<Agente[]>(() => api.get("/api/agentes"), []);
  const [conectar, setConectar] = useState(false);

  if (lineas.cargando && !lineas.datos) return <Cargando />;
  if (lineas.error) return <Banner tono="error" icono="error">{lineas.error}</Banner>;
  const lista = lineas.datos ?? [];
  return (
    <div className="pila">
      <div className="fila e">
        <p className="tenue" style={{ margin: 0 }}>Líneas conectadas a la Cloud API. Cada una tiene protección de envíos y un agente opcional.</p>
        {puede("admin") && <Boton variante="primario" icono="add" onClick={() => setConectar(true)}>Conectar WhatsApp</Boton>}
      </div>
      {lista.length === 0 ? (
        <Tarjeta>
          <Vacio icono="chat" titulo="Aún no hay líneas de WhatsApp" accion={puede("admin") && <Boton variante="primario" icono="add" onClick={() => setConectar(true)}>Conectar WhatsApp</Boton>}>
            Conecta un número para que tu agente responda en WhatsApp y para enviar plantillas en tus campañas.
          </Vacio>
        </Tarjeta>
      ) : (
        <div className="rejilla c2">
          {lista.map((l) => <TarjetaLinea key={l.id} linea={l} agentes={agentes.datos ?? []} alCambiar={lineas.recargar} />)}
        </div>
      )}
      {conectar && <ConectarWhatsapp agentes={agentes.datos ?? []} onCerrar={() => setConectar(false)} onListo={() => { setConectar(false); lineas.recargar(); }} />}
    </div>
  );
}
