// Lista de campañas (secuencias multicanal).
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { ESTADOS_SECUENCIA, pasoVacio, ResumenPasos } from "../componentes/secuencia-comun";
import { Banner, Boton, Campo, Cargando, Encabezado, Insignia, Modal, useAvisos, useCarga, Vacio, fmt } from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Secuencia } from "../tipos";

const COLUMNAS: { estado: string; texto: string }[] = [
  { estado: "activa", texto: "En curso" },
  { estado: "esperando", texto: "Esperando" },
  { estado: "completada", texto: "Completadas" },
  { estado: "respondio", texto: "Respondieron" },
  { estado: "agendo", texto: "Agendaron" },
  { estado: "fallida", texto: "Fallidas" },
  { estado: "baja", texto: "Bajas" },
];

/** Plantilla inicial: 3 intentos de llamada y, si nunca contestó, WhatsApp. */
function pasosPorDefecto() {
  return [
    { ...pasoVacio("llamada"), max_intentos: 3, intentos_por_dia: 1, reintento_min: 240 },
    { ...pasoVacio("whatsapp"), condicion: "no_conecto" as const },
  ];
}

export default function Secuencias() {
  const navegar = useNavigate();
  const avisar = useAvisos();
  const { puede } = useSesion();
  const { datos, error, cargando } = useCarga(() => api.get<Secuencia[]>("/api/secuencias"));
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [guardando, setGuardando] = useState(false);

  const crear = async () => {
    setGuardando(true);
    try {
      const s = await api.post<Secuencia>("/api/secuencias", { nombre: nombre.trim() || "Nueva campaña", pasos: pasosPorDefecto() });
      navegar(`/secuencias/${s.id}`);
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="pagina">
      <Encabezado
        titulo="Campañas"
        descripcion="Secuencias multicanal: llamadas, WhatsApp y correo en un solo flujo, con reintentos, franjas horarias y protección de líneas."
        acciones={puede("editor") && <Boton variante="primario" icono="add" onClick={() => setCreando(true)}>Nueva campaña</Boton>}
      />
      {error && <Banner tono="error" icono="error">{error}</Banner>}
      {cargando && !datos ? (
        <Cargando />
      ) : !datos?.length ? (
        <div className="tarjeta">
          <Vacio icono="campaign" titulo="Aún no hay campañas"
            accion={puede("editor") && <Boton variante="primario" icono="add" onClick={() => setCreando(true)}>Crear la primera</Boton>}>
            Una campaña llama, escribe por WhatsApp o envía correos a tus contactos en el orden que definas, y se detiene
            sola cuando el contacto responde o agenda.
          </Vacio>
        </div>
      ) : (
        <div className="tabla-env">
          <table className="tabla">
            <thead>
              <tr>
                <th>Campaña</th>
                <th>Estado</th>
                <th>Pasos</th>
                {COLUMNAS.map((c) => <th key={c.estado} className="num">{c.texto}</th>)}
                <th>Creada</th>
              </tr>
            </thead>
            <tbody>
              {datos.map((s) => (
                <tr key={s.id} className="clic" onClick={() => navegar(`/secuencias/${s.id}`)}>
                  <td style={{ fontWeight: 600 }}>{s.nombre}</td>
                  <td><Insignia tono={ESTADOS_SECUENCIA[s.estado].tono} punto>{ESTADOS_SECUENCIA[s.estado].texto}</Insignia></td>
                  <td><ResumenPasos pasos={s.pasos} /></td>
                  {COLUMNAS.map((c) => (
                    <td key={c.estado} className="num">{s.conteos[c.estado] ? fmt.numero(s.conteos[c.estado]) : <span className="tenue">0</span>}</td>
                  ))}
                  <td className="tenue chico">{fmt.relativa(s.creado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creando && (
        <Modal titulo="Nueva campaña" onCerrar={() => setCreando(false)}
          pie={<>
            <Boton onClick={() => setCreando(false)}>Cancelar</Boton>
            <Boton variante="primario" cargando={guardando} onClick={crear}>Crear</Boton>
          </>}>
          <Campo etiqueta="Nombre" ayuda="Empieza con 3 intentos de llamada y un WhatsApp si nunca contestó. Lo ajustas después.">
            <input type="text" autoFocus value={nombre} placeholder="Ej. Reactivación clientes Q4"
              onChange={(e) => setNombre(e.target.value)} onKeyDown={(e) => e.key === "Enter" && crear()} />
          </Campo>
        </Modal>
      )}
    </div>
  );
}
