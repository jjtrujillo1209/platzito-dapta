// Inscripciones de una campaña: tabla, historial, acciones manuales e inscripción de contactos.
import { Fragment, useState } from "react";
import { api, qs } from "../api";
import { useSesion } from "../sesion";
import type { Contacto, Inscripcion, Secuencia } from "../tipos";
import { ESTADOS_INSCRIPCION, TIPOS_PASO } from "./secuencia-comun";
import { Banner, Boton, Campo, Cargando, Icono, Insignia, Modal, Pestanas, useAvisos, useCarga, useIntervalo, Vacio, fmt } from "./ui";

const EVENTOS: Record<string, string> = {
  llamada: "Llamada iniciada", resultado: "Resultado de llamada", whatsapp: "WhatsApp enviado", correo: "Correo enviado",
  omitido: "Paso omitido", error: "Error", fin: "Fin", fallback_whatsapp: "Fallback por WhatsApp",
};

function Historial({ i }: { i: Inscripcion }) {
  if (!i.historial?.length) return <span className="tenue chico">Sin eventos todavía.</span>;
  return (
    <ol className="pila c" style={{ margin: 0, paddingLeft: "var(--padding-16)" }}>
      {[...i.historial].reverse().map((h, k) => {
        const { t, paso, evento, ...resto } = h;
        return (
          <li key={k} className="chico">
            <b>{EVENTOS[evento] ?? evento}</b> <span className="tenue">· paso {paso + 1} · {fmt.fecha(t + "Z")}</span>
            {Object.keys(resto).length > 0 && (
              <span className="tenue"> — {Object.entries(resto).map(([kk, v]) => `${kk}: ${String(v)}`).join(" · ")}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ModalInscribir({ s, onCerrar, onListo }: { s: Secuencia; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [modo, setModo] = useState<"filtro" | "elegir">("filtro");
  const [etapa, setEtapa] = useState("");
  const [etiqueta, setEtiqueta] = useState("");
  const [q, setQ] = useState("");
  const [elegidos, setElegidos] = useState<Set<number>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const busqueda = useCarga(() => api.get<{ total: number; contactos: Contacto[]; etapas: string[] }>(`/api/contactos${qs({ q, por_pagina: 50 })}`), [q]);

  const inscribir = async () => {
    setEnviando(true);
    try {
      const cuerpo = modo === "filtro" ? { etapa, etiqueta } : { contacto_ids: [...elegidos] };
      const r = await api.post<{ inscritos: number; omitidos: number }>(`/api/secuencias/${s.id}/inscribir`, cuerpo);
      avisar(`${r.inscritos} inscritos${r.omitidos ? ` · ${r.omitidos} ya estaban o no existen` : ""}`);
      onListo();
      onCerrar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  const etapas = busqueda.datos?.etapas ?? [];

  return (
    <Modal titulo="Inscribir contactos" onCerrar={onCerrar} grande
      pie={<>
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" cargando={enviando} onClick={inscribir}
          disabled={modo === "filtro" ? !etapa && !etiqueta : elegidos.size === 0}>
          Inscribir{modo === "elegir" && elegidos.size ? ` ${elegidos.size}` : ""}
        </Boton>
      </>}>
      {s.estado !== "activa" && <Banner tono="aviso" icono="info">La campaña no está activa: los contactos quedarán en cola hasta que la actives.</Banner>}
      <Pestanas valor={modo} onCambio={setModo} opciones={[
        { id: "filtro", texto: "Por segmento", icono: "filter_alt" },
        { id: "elegir", texto: "Elegir contactos", icono: "checklist" },
      ]} />
      {modo === "filtro" ? (
        <div className="rejilla c2">
          <Campo etiqueta="Etapa">
            <select value={etapa} onChange={(e) => setEtapa(e.target.value)}>
              <option value="">Cualquiera</option>
              {etapas.map((x) => <option key={x}>{x}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Etiqueta"><input type="text" value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} placeholder="Ej. feria" /></Campo>
        </div>
      ) : (
        <div className="pila c">
          <input type="search" placeholder="Buscar por nombre, teléfono, correo o empresa" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="tabla-env" style={{ maxHeight: 360, overflowY: "auto" }}>
            <table className="tabla">
              <tbody>
                {(busqueda.datos?.contactos ?? []).map((c) => (
                  <tr key={c.id} className="clic" onClick={() => {
                    const n = new Set(elegidos);
                    if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
                    setElegidos(n);
                  }}>
                    <td style={{ width: 32 }}><input type="checkbox" readOnly checked={elegidos.has(c.id)} /></td>
                    <td>{c.nombre || <span className="tenue">Sin nombre</span>}</td>
                    <td className="mono">{c.telefono}</td>
                    <td className="tenue">{c.email}</td>
                    <td>{c.etapa}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function ContactosSecuencia({ s, onCambio }: { s: Secuencia; onCambio: () => void }) {
  const avisar = useAvisos();
  const { puede } = useSesion();
  const [estado, setEstado] = useState("");
  const [pagina, setPagina] = useState(1);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [inscribiendo, setInscribiendo] = useState(false);
  const [confirmar, setConfirmar] = useState<Inscripcion | null>(null);
  const { datos, cargando, recargar } = useCarga(
    () => api.get<{ total: number; inscripciones: Inscripcion[] }>(`/api/secuencias/${s.id}/inscripciones${qs({ estado, pagina })}`),
    [s.id, estado, pagina]);
  useIntervalo(recargar, s.estado === "activa" ? 10000 : null);

  const ejecutar = async (i: Inscripcion) => {
    try {
      const r = await api.post<{ resultado: string }>(`/api/secuencias/inscripciones/${i.id}/ejecutar-ahora`);
      avisar(`Resultado: ${r.resultado}`);
      recargar();
      onCambio();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setConfirmar(null);
    }
  };
  const detener = async (i: Inscripcion) => {
    try {
      await api.post(`/api/secuencias/inscripciones/${i.id}/detener`);
      recargar();
      onCambio();
    } catch (e) {
      avisar((e as Error).message, true);
    }
  };
  const total = datos?.total ?? 0;

  return (
    <div className="pila">
      <div className="fila e">
        <div className="fila">
          <select value={estado} style={{ width: 220 }} onChange={(e) => { setEstado(e.target.value); setPagina(1); }}>
            <option value="">Todos los estados</option>
            {Object.entries(ESTADOS_INSCRIPCION).map(([k, v]) => <option key={k} value={k}>{v.texto}</option>)}
          </select>
          <span className="tenue chico">{fmt.numero(total)} contactos</span>
        </div>
        {puede("operador") && <Boton variante="primario" icono="person_add" onClick={() => setInscribiendo(true)}>Inscribir contactos</Boton>}
      </div>
      {cargando && !datos ? <Cargando /> : !datos?.inscripciones.length ? (
        <div className="tarjeta"><Vacio icono="group" titulo="Sin contactos inscritos">Inscribe contactos por segmento, desde la importación de CSV o por API.</Vacio></div>
      ) : (
        <div className="tabla-env">
          <table className="tabla">
            <thead>
              <tr>
                <th>Contacto</th><th>Estado</th><th>Paso</th><th>Próximo</th><th className="num">Intentos</th>
                <th>Señales</th><th>Último error</th><th />
              </tr>
            </thead>
            <tbody>
              {datos.inscripciones.map((i) => {
                const e = ESTADOS_INSCRIPCION[i.estado] ?? { texto: i.estado, tono: "" as const };
                const paso = s.pasos[i.paso];
                const viva = i.estado === "activa" || i.estado === "esperando";
                return (
                  <Fragment key={i.id}>
                    <tr className="clic" onClick={() => setAbierta(abierta === i.id ? null : i.id)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{i.contacto?.nombre || <span className="tenue">Sin nombre</span>}</div>
                        <div className="chico tenue mono">{i.contacto?.telefono ?? i.contacto?.email}</div>
                      </td>
                      <td><Insignia tono={e.tono}>{e.texto}</Insignia></td>
                      <td>{paso ? <span className="fila" style={{ gap: 4 }}><Icono n={TIPOS_PASO[paso.tipo].icono} />{i.paso + 1}/{s.pasos.length}</span> : "—"}</td>
                      <td className="chico">{viva ? fmt.relativa(i.proximo_en) : "—"}</td>
                      <td className="num">{i.intentos_paso}</td>
                      <td>
                        <span className="fila" style={{ gap: 4 }}>
                          {i.conecto && <Insignia tono="ok">Contestó</Insignia>}
                          {i.respondio && <Insignia tono="ok">Respondió</Insignia>}
                        </span>
                      </td>
                      <td className="chico" style={{ color: i.ultimo_error ? "var(--error)" : undefined, maxWidth: 240 }}>
                        <span className="trunc" style={{ display: "block" }} title={i.ultimo_error}>{i.ultimo_error || "—"}</span>
                      </td>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        {puede("operador") && (
                          <span className="acciones">
                            <Boton chico variante="contorno" icono="play_arrow" disabled={i.estado === "esperando"} onClick={() => setConfirmar(i)}>Ejecutar ahora</Boton>
                            {viva && <Boton chico variante="texto" icono="stop_circle" onClick={() => detener(i)}>Detener</Boton>}
                          </span>
                        )}
                      </td>
                    </tr>
                    {abierta === i.id && (
                      <tr><td colSpan={8} style={{ background: "var(--surf-cont-lowest)" }}><Historial i={i} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > 100 && (
        <div className="fila" style={{ justifyContent: "center" }}>
          <Boton chico icono="chevron_left" disabled={pagina === 1} onClick={() => setPagina(pagina - 1)} />
          <span className="chico">Página {pagina} de {Math.ceil(total / 100)}</span>
          <Boton chico icono="chevron_right" disabled={pagina * 100 >= total} onClick={() => setPagina(pagina + 1)} />
        </div>
      )}
      {inscribiendo && <ModalInscribir s={s} onCerrar={() => setInscribiendo(false)} onListo={() => { recargar(); onCambio(); }} />}
      {confirmar && (
        <Modal titulo="¿Ejecutar ahora?" onCerrar={() => setConfirmar(null)}
          pie={<><Boton onClick={() => setConfirmar(null)}>Cancelar</Boton><Boton variante="primario" onClick={() => ejecutar(confirmar)}>Ejecutar</Boton></>}>
          <Banner tono="aviso" icono="warning">
            Esto ejecuta el paso actual de <b>{confirmar.contacto?.nombre || confirmar.contacto?.telefono}</b> de inmediato,
            <b> saltándose la franja horaria y la espera</b>. Si la inscripción ya había terminado, se reactiva en su último paso.
            El cooldown de llamadas, el opt-out y los topes de WhatsApp se siguen respetando.
          </Banner>
        </Modal>
      )}
    </div>
  );
}
