// Lista de agentes, alta manual y copiloto de IA que redacta el agente a partir de una descripción.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Banner, Boton, Campo, Cargando, Encabezado, Icono, Insignia, Modal, Vacio, fmt, useAvisos, useCarga } from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Agente, ConfigAgente } from "../tipos";

function NuevoAgente({ onCerrar }: { onCerrar: () => void }) {
  const navegar = useNavigate();
  const avisar = useAvisos();
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [cargando, setCargando] = useState(false);
  const crear = async () => {
    setCargando(true);
    try {
      const a = await api.post<Agente>("/api/agentes", { nombre, descripcion });
      navegar(`/agentes/${a.id}`);
    } catch (e) {
      avisar((e as Error).message, true);
      setCargando(false);
    }
  };
  return (
    <Modal titulo="Nuevo agente" onCerrar={onCerrar} pie={<>
      <Boton onClick={onCerrar}>Cancelar</Boton>
      <Boton variante="primario" disabled={!nombre.trim()} cargando={cargando} onClick={crear}>Crear</Boton>
    </>}>
      <Campo etiqueta="Nombre"><input type="text" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
      <Campo etiqueta="Descripción interna" ayuda="Solo la ve tu equipo.">
        <input type="text" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
      </Campo>
    </Modal>
  );
}

function Copiloto({ onCerrar }: { onCerrar: () => void }) {
  const navegar = useNavigate();
  const avisar = useAvisos();
  const [descripcion, setDescripcion] = useState("");
  const [canal, setCanal] = useState("omnicanal");
  const [cargando, setCargando] = useState(false);
  const generar = async () => {
    setCargando(true);
    try {
      const g = await api.post<{ nombre: string; config: ConfigAgente }>("/api/agentes/generar", { descripcion, canal });
      const a = await api.post<Agente>("/api/agentes", { nombre: g.nombre, config: g.config });
      avisar("Agente redactado. Revisa y prueba antes de publicar.");
      navegar(`/agentes/${a.id}`);
    } catch (e) {
      avisar((e as Error).message, true);
      setCargando(false);
    }
  };
  return (
    <Modal titulo="Crear agente con IA" onCerrar={onCerrar} pie={<>
      <Boton onClick={onCerrar}>Cancelar</Boton>
      <Boton variante="primario" icono="auto_awesome" disabled={descripcion.trim().length < 10} cargando={cargando} onClick={generar}>
        Redactar agente
      </Boton>
    </>}>
      <Banner icono="auto_awesome">
        Describe qué debe lograr el agente, a quién le habla y qué no debe hacer. La IA escribe el prompt, el saludo y
        los datos a extraer usando el contexto de tu empresa.
      </Banner>
      <Campo etiqueta="¿Qué hace el agente?">
        <textarea rows={7} autoFocus value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
          placeholder="Ej.: Califica empresas que llenaron el formulario de Platzi Business: pregunta tamaño del equipo, áreas a capacitar y presupuesto; si califica, agenda una reunión con un asesor." />
      </Campo>
      <Campo etiqueta="Canal principal">
        <select value={canal} onChange={(e) => setCanal(e.target.value)}>
          <option value="omnicanal">Omnicanal (texto y voz)</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="voz">Llamadas de voz</option>
          <option value="widget">Chat web</option>
        </select>
      </Campo>
    </Modal>
  );
}

export default function Agentes() {
  const { puede } = useSesion();
  const avisar = useAvisos();
  const navegar = useNavigate();
  const { datos, cargando, error, recargar } = useCarga(() => api.get<Agente[]>("/api/agentes"));
  const [modal, setModal] = useState<"" | "nuevo" | "ia">("");
  const editor = puede("editor");

  const duplicar = async (a: Agente) => {
    try {
      const b = await api.post<Agente>(`/api/agentes/${a.id}/duplicar`);
      avisar("Agente duplicado");
      navegar(`/agentes/${b.id}`);
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const archivar = async (a: Agente) => {
    if (!confirm(`¿Archivar "${a.nombre}"? Dejará de responder en todos los canales.`)) return;
    try {
      await api.del(`/api/agentes/${a.id}`);
      avisar("Agente archivado");
      recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };

  return (
    <div className="pagina">
      <Encabezado
        titulo="Agentes"
        descripcion="Un mismo agente atiende WhatsApp, el chat web y las llamadas con el mismo cerebro."
        acciones={editor && <>
          <Boton icono="add" onClick={() => setModal("nuevo")}>Nuevo</Boton>
          <Boton variante="primario" icono="auto_awesome" onClick={() => setModal("ia")}>Crear con IA</Boton>
        </>}
      />
      {error && <Banner tono="error">{error}</Banner>}
      {cargando && !datos ? <Cargando /> : datos && datos.length === 0 ? (
        <Vacio icono="smart_toy" titulo="Aún no tienes agentes"
          accion={editor && <Boton variante="primario" icono="auto_awesome" onClick={() => setModal("ia")}>Crear mi primer agente</Boton>}>
          Describe lo que necesitas y la IA redacta el agente; luego lo pruebas en el playground y el simulador antes de publicarlo.
        </Vacio>
      ) : (
        <div className="tabla-env">
          <table className="tabla">
            <thead>
              <tr><th>Agente</th><th>Estado</th><th>Voz (Retell)</th><th>Actualizado</th><th /></tr>
            </thead>
            <tbody>
              {datos?.map((a) => (
                <tr key={a.id} className="clic" onClick={() => navegar(`/agentes/${a.id}`)}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{a.nombre}</div>
                    {a.descripcion && <div className="chico tenue">{a.descripcion}</div>}
                  </td>
                  <td>
                    <div className="fila" style={{ gap: "var(--gap-4)" }}>
                      {a.publicado ? <Insignia tono="ok" punto>v{a.version_publicada} publicada</Insignia> : <Insignia>Borrador</Insignia>}
                      {a.cambios_sin_publicar && <Insignia tono="aviso">Cambios sin publicar</Insignia>}
                    </div>
                  </td>
                  <td>
                    {a.retell_agent_id ? <Insignia tono="info"><Icono n="call" /> Sincronizado {fmt.relativa(a.retell_sincronizado)}</Insignia>
                      : <span className="tenue chico">Sin voz</span>}
                  </td>
                  <td className="tenue">{fmt.relativa(a.actualizado)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {editor && (
                      <div className="acciones" style={{ justifyContent: "flex-end" }}>
                        <Boton chico icono="content_copy" title="Duplicar" onClick={() => duplicar(a)} />
                        {puede("admin") && <Boton chico icono="archive" title="Archivar" onClick={() => archivar(a)} />}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal === "nuevo" && <NuevoAgente onCerrar={() => setModal("")} />}
      {modal === "ia" && <Copiloto onCerrar={() => setModal("")} />}
    </div>
  );
}
