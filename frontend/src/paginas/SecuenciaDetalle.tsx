// Detalle de una campaña: pasos, configuración, contactos y resultados.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, qs } from "../api";
import { ESTADOS_SECUENCIA } from "../componentes/secuencia-comun";
import ConfigSecuencia, { type BorradorSecuencia } from "../componentes/secuencia-config";
import ContactosSecuencia from "../componentes/secuencia-contactos";
import PasosSecuencia from "../componentes/secuencia-pasos";
import ResultadosSecuencia from "../componentes/secuencia-resultados";
import { Banner, Boton, Cargando, Encabezado, Insignia, Modal, Pestanas, useAvisos, useCarga } from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Agente, Inscripcion, Linea, Numero, Plantilla, Secuencia } from "../tipos";

type Pestana = "pasos" | "config" | "contactos" | "resultados";

function borradorDe(s: Secuencia): BorradorSecuencia {
  const { id: _id, estado: _e, conteos: _c, creado: _cr, ...resto } = s;
  return JSON.parse(JSON.stringify(resto));
}

export default function SecuenciaDetalle() {
  const { id } = useParams();
  const navegar = useNavigate();
  const avisar = useAvisos();
  const { puede } = useSesion();
  const [pestana, setPestana] = useState<Pestana>("pasos");
  const { datos: s, setDatos: setS, error, cargando, recargar } = useCarga(() => api.get<Secuencia>(`/api/secuencias/${id}`), [id]);
  const agentes = useCarga(() => api.get<Agente[]>("/api/agentes")).datos ?? [];
  const plantillas = useCarga(() => api.get<Plantilla[]>("/api/plantillas")).datos ?? [];
  const numeros = useCarga(() => api.get<Numero[]>("/api/numeros")).datos ?? [];
  const lineas = useCarga(() => api.get<Linea[]>("/api/lineas")).datos ?? [];
  const errores = useCarga(
    () => (s?.estado === "pausada"
      ? api.get<{ inscripciones: Inscripcion[] }>(`/api/secuencias/${id}/inscripciones${qs({ estado: "activa" })}`)
      : Promise.resolve({ inscripciones: [] as Inscripcion[] })),
    [id, s?.estado]);
  const [borrador, setBorrador] = useState<BorradorSecuencia | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [archivando, setArchivando] = useState(false);
  const [editandoNombre, setEditandoNombre] = useState(false);

  useEffect(() => {
    if (s) setBorrador(borradorDe(s));
  }, [s]);

  const sucio = useMemo(() => !!s && !!borrador && JSON.stringify(borradorDe(s)) !== JSON.stringify(borrador), [s, borrador]);
  const soloLectura = !puede("editor");
  const ultimoError = errores.datos?.inscripciones.find((i) => i.ultimo_error)?.ultimo_error;

  if (cargando && !s) return <div className="pagina"><Cargando /></div>;
  if (error || !s || !borrador) return <div className="pagina"><Banner tono="error" icono="error">{error ?? "No encontrada"}</Banner></div>;

  const guardar = async (): Promise<boolean> => {
    setGuardando(true);
    try {
      setS(await api.put<Secuencia>(`/api/secuencias/${s.id}`, borrador));
      avisar("Campaña guardada");
      return true;
    } catch (e) {
      avisar((e as Error).message, true);
      return false;
    } finally {
      setGuardando(false);
    }
  };
  const cambiarEstado = async (accion: "activar" | "pausar") => {
    if (sucio && !(await guardar())) return;
    try {
      setS(await api.post<Secuencia>(`/api/secuencias/${s.id}/${accion}`));
      avisar(accion === "activar" ? "Campaña activa" : "Campaña en pausa");
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const archivar = async () => {
    try {
      await api.del(`/api/secuencias/${s.id}`);
      navegar("/secuencias");
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const est = ESTADOS_SECUENCIA[s.estado];

  return (
    <div className="pagina">
      <div className="fila" style={{ marginBottom: "var(--gap-8)" }}>
        <Boton chico variante="texto" icono="arrow_back" onClick={() => navegar("/secuencias")}>Campañas</Boton>
      </div>
      <Encabezado
        titulo={
          editandoNombre ? (
            <input type="text" autoFocus value={borrador.nombre} style={{ fontSize: 22, fontFamily: "var(--font-display)" }}
              onChange={(e) => setBorrador({ ...borrador, nombre: e.target.value })}
              onBlur={() => setEditandoNombre(false)} onKeyDown={(e) => e.key === "Enter" && setEditandoNombre(false)} />
          ) : (
            <span className="fila">
              {borrador.nombre}
              <Insignia tono={est.tono} punto>{est.texto}</Insignia>
              {puede("editor") && <Boton chico variante="texto" icono="edit" aria-label="Renombrar" onClick={() => setEditandoNombre(true)} />}
            </span>
          )
        }
        descripcion={`${s.pasos.length} pasos · ${Object.values(s.conteos).reduce((a, b) => a + b, 0)} contactos`}
        acciones={<>
          {sucio && puede("editor") && <Boton variante="primario" icono="save" cargando={guardando} onClick={guardar}>Guardar cambios</Boton>}
          {s.estado === "activa" ? (
            puede("operador") && <Boton variante="contorno" icono="pause" onClick={() => cambiarEstado("pausar")}>Pausar</Boton>
          ) : (
            puede("editor") && s.estado !== "archivada" && (
              <Boton variante={sucio ? "secundario" : "primario"} icono="play_arrow" onClick={() => cambiarEstado("activar")}>Activar</Boton>
            )
          )}
          {puede("admin") && <Boton variante="texto" icono="archive" onClick={() => setArchivando(true)} aria-label="Archivar" />}
        </>}
      />
      {s.estado === "pausada" && (
        <div style={{ marginBottom: "var(--gap-16)" }}>
          <Banner tono="aviso" icono="pause_circle">
            La campaña está en pausa. Si se pausó sola es por un error de configuración (agente sin publicar, sin números
            de salida, plantilla no aprobada o integración faltante): así no se queman contactos. Corrígelo y vuelve a activarla.
            {ultimoError && <div style={{ marginTop: 4 }}><b>Último error:</b> {ultimoError}</div>}
          </Banner>
        </div>
      )}
      <Pestanas valor={pestana} onCambio={setPestana} opciones={[
        { id: "pasos", texto: "Pasos", icono: "account_tree" },
        { id: "config", texto: "Configuración", icono: "tune" },
        { id: "contactos", texto: "Contactos", icono: "group" },
        { id: "resultados", texto: "Resultados", icono: "insights" },
      ]} />
      {pestana === "pasos" && (
        <PasosSecuencia pasos={borrador.pasos} onCambio={(pasos) => setBorrador({ ...borrador, pasos })}
          agentes={agentes} plantillas={plantillas} soloLectura={soloLectura} />
      )}
      {pestana === "config" && (
        <ConfigSecuencia s={borrador} onCambio={setBorrador} agentes={agentes} numeros={numeros} lineas={lineas} soloLectura={soloLectura} />
      )}
      {pestana === "contactos" && <ContactosSecuencia s={s} onCambio={recargar} />}
      {pestana === "resultados" && <ResultadosSecuencia id={s.id} agentes={agentes} />}
      {archivando && (
        <Modal titulo="¿Archivar campaña?" onCerrar={() => setArchivando(false)}
          pie={<><Boton onClick={() => setArchivando(false)}>Cancelar</Boton><Boton variante="peligro" onClick={archivar}>Archivar</Boton></>}>
          <p>La campaña deja de ejecutarse y sale de la lista. Las llamadas y mensajes ya realizados se conservan.</p>
        </Modal>
      )}
    </div>
  );
}
