// Ajustes: espacio, equipo, integraciones, API/MCP, webhooks y eventos.
import { useEffect, useState } from "react";
import { api } from "../api";
import { ApiMcp, Eventos, Integraciones, Webhooks, copiar } from "../componentes/ajustes-integraciones";
import { Banner, Boton, Campo, Cargando, Encabezado, Insignia, Modal, Pestanas, Tarjeta, useAvisos, useCarga } from "../componentes/ui";
import { useSesion } from "../sesion";
import { NIVEL_ROL, type Rol } from "../tipos";

type Pestana = "espacio" | "equipo" | "integraciones" | "api" | "webhooks" | "eventos";

const ZONAS = [
  "America/Bogota", "America/Mexico_City", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires",
  "America/Guayaquil", "America/Caracas", "America/La_Paz", "America/Asuncion", "America/Montevideo",
  "America/Panama", "America/Costa_Rica", "America/Guatemala", "America/El_Salvador", "America/Tegucigalpa",
  "America/Santo_Domingo", "America/New_York", "America/Los_Angeles", "Europe/Madrid", "UTC",
];
const ROLES: { id: Rol; texto: string; desc: string }[] = [
  { id: "propietario", texto: "Propietario", desc: "Todo, incluida la facturación" },
  { id: "admin", texto: "Admin", desc: "Integraciones, canales, equipo y claves" },
  { id: "editor", texto: "Editor", desc: "Agentes, conocimiento y campañas" },
  { id: "operador", texto: "Operador", desc: "Inbox, contactos y campañas en curso" },
  { id: "lector", texto: "Lector", desc: "Solo lectura" },
];

function EspacioForm() {
  const { espacio, recargarEspacio, puede } = useSesion();
  const avisar = useAvisos();
  const [f, setF] = useState({ nombre: "", zona_horaria: "America/Bogota", concurrencia_llamadas: 5, contexto_empresa: "" });
  const [url, setUrl] = useState("");
  const [generando, setGenerando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (espacio) setF({ nombre: espacio.nombre, zona_horaria: espacio.zona_horaria, concurrencia_llamadas: espacio.concurrencia_llamadas, contexto_empresa: espacio.contexto_empresa });
  }, [espacio]);
  if (!espacio) return <Cargando />;
  const admin = puede("admin");

  const guardar = async () => {
    setGuardando(true);
    try {
      await api.patch("/api/espacio", f);
      await recargarEspacio();
      avisar("Espacio actualizado");
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setGuardando(false);
    }
  };
  const generar = async () => {
    setGenerando(true);
    try {
      const r = await api.post<{ contexto: string }>("/api/espacio/contexto-desde-url", { url });
      setF({ ...f, contexto_empresa: r.contexto });
      avisar("Contexto generado: revísalo antes de guardar");
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setGenerando(false);
    }
  };

  return (
    <div className="rejilla c2" style={{ alignItems: "start" }}>
      <Tarjeta titulo="Datos del espacio" icono="apartment">
        <div className="pila">
          <Campo etiqueta="Nombre"><input type="text" disabled={!admin} value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
          <Campo etiqueta="Zona horaria" ayuda="Por defecto para campañas y agenda; cada contacto puede tener la suya">
            <input type="text" list="zonas" disabled={!admin} value={f.zona_horaria} onChange={(e) => setF({ ...f, zona_horaria: e.target.value })} />
            <datalist id="zonas">{ZONAS.map((z) => <option key={z} value={z} />)}</datalist>
          </Campo>
          <Campo etiqueta="Llamadas simultáneas" ayuda={`Plan ${espacio.plan}: el máximo lo limita tu plan`}>
            <input type="number" min={1} max={100} disabled={!admin} value={f.concurrencia_llamadas} onChange={(e) => setF({ ...f, concurrencia_llamadas: Number(e.target.value) })} />
          </Campo>
          <div className="fila"><span className="tenue chico">Tu rol:</span><Insignia tono="primaria">{espacio.rol}</Insignia></div>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Contexto de la empresa" icono="storefront">
        <div className="pila">
          <p className="chico tenue" style={{ margin: 0 }}>
            Se inyecta en las instrucciones de todos los agentes que lo tengan activado. Para catálogos y documentos largos usa
            un cerebro de Conocimiento.
          </p>
          {admin && (
            <div className="fila">
              <input type="url" className="crece" style={{ flex: 1 }} placeholder="https://tuempresa.com" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
              <Boton icono="auto_awesome" cargando={generando} disabled={!/^https?:\/\//.test(url)} onClick={generar}>Generar desde la web</Boton>
            </div>
          )}
          <textarea rows={12} disabled={!admin} value={f.contexto_empresa} onChange={(e) => setF({ ...f, contexto_empresa: e.target.value })}
            placeholder="Qué hace la empresa, a quién sirve, productos, diferenciales, horarios, tono…" />
        </div>
      </Tarjeta>
      {admin && <div><Boton variante="primario" cargando={guardando} onClick={guardar}>Guardar cambios</Boton></div>}
    </div>
  );
}

interface Miembros {
  miembros: { id: number; usuario_id: number; nombre: string; email: string; rol: Rol }[];
  invitaciones: { id: number; email: string; rol: Rol; token?: string }[];
}

function Equipo() {
  const { espacio, sesion, puede } = useSesion();
  const avisar = useAvisos();
  const { datos, cargando, recargar } = useCarga<Miembros>(() => api.get("/api/miembros"), []);
  const [invitar, setInvitar] = useState(false);
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<Rol>("editor");
  const [enlace, setEnlace] = useState<string | null>(null);
  const admin = puede("admin");
  const miNivel = espacio ? NIVEL_ROL[espacio.rol] : 0;
  const enlaceDe = (token: string) => `${window.location.origin}/invitacion/${token}`;

  const enviar = async () => {
    try {
      const r = await api.post<{ token: string }>("/api/invitaciones", { email, rol });
      setEnlace(enlaceDe(r.token));
      setEmail("");
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const cambiarRol = async (id: number, nuevo: Rol) => {
    try {
      await api.patch(`/api/miembros/${id}`, { rol: nuevo });
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const quitar = async (id: number, nombre: string) => {
    if (!confirm(`¿Quitar a ${nombre} del espacio?`)) return;
    try {
      await api.del(`/api/miembros/${id}`);
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const revocar = async (id: number) => {
    await api.del(`/api/invitaciones/${id}`);
    recargar();
  };

  if (cargando && !datos) return <Cargando />;
  return (
    <div className="pila">
      <Tarjeta titulo="Miembros" icono="group" acciones={admin && <Boton variante="primario" chico icono="person_add" onClick={() => { setEnlace(null); setInvitar(true); }}>Invitar</Boton>}>
        <div className="tabla-env">
          <table className="tabla">
            <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th /></tr></thead>
            <tbody>
              {(datos?.miembros ?? []).map((m) => (
                <tr key={m.id}>
                  <td>{m.nombre}{m.usuario_id === sesion?.usuario.id && <span className="tenue"> (tú)</span>}</td>
                  <td>{m.email}</td>
                  <td>
                    {admin && m.rol !== "propietario" && m.usuario_id !== sesion?.usuario.id ? (
                      <select value={m.rol} onChange={(e) => cambiarRol(m.id, e.target.value as Rol)} style={{ width: 160 }}>
                        {ROLES.filter((r) => NIVEL_ROL[r.id] <= miNivel).map((r) => <option key={r.id} value={r.id}>{r.texto}</option>)}
                      </select>
                    ) : <Insignia>{m.rol}</Insignia>}
                  </td>
                  <td>{admin && m.rol !== "propietario" && m.usuario_id !== sesion?.usuario.id && (
                    <Boton chico variante="texto" icono="person_remove" onClick={() => quitar(m.id, m.nombre)} aria-label="Quitar" />
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>
      {(datos?.invitaciones ?? []).length > 0 && (
        <Tarjeta titulo="Invitaciones pendientes" icono="mail">
          <div className="pila c">
            {(datos?.invitaciones ?? []).map((i) => (
              <div key={i.id} className="fila e">
                <span>{i.email} <Insignia>{i.rol}</Insignia></span>
                {admin && (
                  <div className="acciones">
                    {i.token && <Boton chico icono="content_copy" onClick={() => copiar(enlaceDe(i.token!), avisar)}>Copiar enlace</Boton>}
                    <Boton chico variante="texto" icono="close" onClick={() => revocar(i.id)} aria-label="Revocar" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Tarjeta>
      )}
      <Tarjeta titulo="Roles" icono="admin_panel_settings" className="plana">
        <div className="pila c chico">{ROLES.map((r) => <div key={r.id}><b>{r.texto}:</b> <span className="tenue">{r.desc}</span></div>)}</div>
      </Tarjeta>
      {invitar && (
        <Modal titulo="Invitar al equipo" onCerrar={() => setInvitar(false)} pie={
          enlace ? <Boton variante="primario" onClick={() => setInvitar(false)}>Listo</Boton>
            : <><Boton onClick={() => setInvitar(false)}>Cancelar</Boton><Boton variante="primario" disabled={!email.includes("@")} onClick={enviar}>Crear invitación</Boton></>
        }>
          {enlace ? (
            <Banner tono="ok" icono="link">
              <div className="pila c">
                <span>Comparte este enlace con la persona invitada:</span>
                <div className="fila"><code className="crece trunc">{enlace}</code><Boton chico icono="content_copy" onClick={() => copiar(enlace, avisar)}>Copiar</Boton></div>
              </div>
            </Banner>
          ) : (
            <>
              <Campo etiqueta="Correo"><input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Campo>
              <Campo etiqueta="Rol">
                <select value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
                  {ROLES.filter((r) => NIVEL_ROL[r.id] <= miNivel).map((r) => <option key={r.id} value={r.id}>{r.texto} · {r.desc}</option>)}
                </select>
              </Campo>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

export default function Ajustes() {
  const { puede } = useSesion();
  const admin = puede("admin");
  const [pestana, setPestana] = useState<Pestana>("espacio");
  const opciones: { id: Pestana; texto: string; icono: string }[] = [
    { id: "espacio", texto: "Espacio", icono: "apartment" },
    { id: "equipo", texto: "Equipo", icono: "group" },
    ...(admin ? ([
      { id: "integraciones", texto: "Integraciones", icono: "extension" },
      { id: "api", texto: "API y MCP", icono: "key" },
      { id: "webhooks", texto: "Webhooks", icono: "webhook" },
    ] as const) : []),
    { id: "eventos", texto: "Eventos", icono: "receipt_long" },
  ];
  const actual = opciones.some((o) => o.id === pestana) ? pestana : "espacio";
  return (
    <div className="pagina">
      <Encabezado titulo="Ajustes" descripcion="Configura tu espacio, tu equipo y cómo se conecta Platzito con otros sistemas." />
      <Pestanas<Pestana> valor={actual} onCambio={setPestana} opciones={opciones} />
      {!admin && actual === "espacio" && <Banner icono="lock">Solo administradores pueden cambiar integraciones, claves y webhooks.</Banner>}
      {actual === "espacio" && <EspacioForm />}
      {actual === "equipo" && <Equipo />}
      {actual === "integraciones" && admin && <Integraciones />}
      {actual === "api" && admin && <ApiMcp />}
      {actual === "webhooks" && admin && <Webhooks />}
      {actual === "eventos" && <Eventos />}
    </div>
  );
}
