// Pestaña Telefonía de Canales: troncales SIP y números de salida/entrada.
import { useState } from "react";
import { api } from "../api";
import { useSesion } from "../sesion";
import type { Agente, Numero, Troncal } from "../tipos";
import { Banner, Boton, Campo, Cargando, Check, Insignia, Modal, Tarjeta, Vacio, fmt, useAvisos, useCarga } from "./ui";

type FormTroncal = { nombre: string; termination_uri: string; usuario: string; clave: string; canales: number };

function ModalTroncal({ troncal, onCerrar, onListo }: { troncal: Troncal | null; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [f, setF] = useState<FormTroncal>({
    nombre: troncal?.nombre ?? "", termination_uri: troncal?.termination_uri ?? "", usuario: troncal?.usuario ?? "", clave: "",
    canales: troncal?.canales ?? 10,
  });
  const [enviando, setEnviando] = useState(false);
  const guardar = async () => {
    setEnviando(true);
    try {
      if (troncal) await api.patch(`/api/troncales/${troncal.id}`, f);
      else await api.post("/api/troncales", f);
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Modal titulo={troncal ? "Editar troncal SIP" : "Nueva troncal SIP"} onCerrar={onCerrar} pie={
      <><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={enviando} disabled={!f.nombre || !f.termination_uri} onClick={guardar}>Guardar</Boton></>
    }>
      <Campo etiqueta="Nombre"><input type="text" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
      <Campo etiqueta="Termination URI" ayuda="Host del operador, p. ej. miempresa.pstn.operador.com">
        <input type="text" value={f.termination_uri} onChange={(e) => setF({ ...f, termination_uri: e.target.value.trim() })} />
      </Campo>
      <div className="rejilla c2">
        <Campo etiqueta="Usuario SIP"><input type="text" value={f.usuario} onChange={(e) => setF({ ...f, usuario: e.target.value })} /></Campo>
        <Campo etiqueta="Contraseña SIP" ayuda={troncal?.tiene_clave ? "Vacío = conservar la actual" : "Se guarda cifrada"}>
          <input type="password" value={f.clave} onChange={(e) => setF({ ...f, clave: e.target.value })} />
        </Campo>
      </div>
      <Campo etiqueta="Canales concurrentes"><input type="number" min={1} value={f.canales} onChange={(e) => setF({ ...f, canales: Number(e.target.value) })} /></Campo>
    </Modal>
  );
}

type FormNumero = { numero: string; etiqueta: string; proveedor: "sip" | "retell" | "twilio"; troncal_id: number | null; agente_entrante_id: number | null; tope_diario: number; activo: boolean };

function ModalNumero({ numero, troncales, agentes, onCerrar, onListo }: { numero: Numero | null; troncales: Troncal[]; agentes: Agente[]; onCerrar: () => void; onListo: () => void }) {
  const avisar = useAvisos();
  const [f, setF] = useState<FormNumero>({
    numero: numero?.numero ?? "", etiqueta: numero?.etiqueta ?? "", proveedor: numero?.proveedor ?? "sip",
    troncal_id: numero?.troncal_id ?? troncales[0]?.id ?? null, agente_entrante_id: numero?.agente_entrante_id ?? null,
    tope_diario: numero?.tope_diario ?? 150, activo: numero?.activo ?? true,
  });
  const [enviando, setEnviando] = useState(false);
  const guardar = async () => {
    setEnviando(true);
    try {
      if (numero) {
        const { numero: _n, proveedor: _p, ...cambios } = f;
        await api.patch(`/api/numeros/${numero.id}`, cambios);
      } else await api.post("/api/numeros", f);
      onListo();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Modal titulo={numero ? "Editar número" : "Nuevo número"} onCerrar={onCerrar} pie={
      <><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={enviando} disabled={!f.numero} onClick={guardar}>Guardar</Boton></>
    }>
      <div className="rejilla c2">
        <Campo etiqueta="Número" ayuda="Formato internacional, p. ej. +57 601 …">
          <input type="tel" value={f.numero} disabled={!!numero} onChange={(e) => setF({ ...f, numero: e.target.value })} />
        </Campo>
        <Campo etiqueta="Etiqueta"><input type="text" value={f.etiqueta} onChange={(e) => setF({ ...f, etiqueta: e.target.value })} /></Campo>
      </div>
      <div className="rejilla c2">
        <Campo etiqueta="Proveedor">
          <select value={f.proveedor} disabled={!!numero} onChange={(e) => setF({ ...f, proveedor: e.target.value as FormNumero["proveedor"] })}>
            <option value="sip">SIP trunk propio</option>
            <option value="retell">Comprado en Retell</option>
            <option value="twilio">Twilio</option>
          </select>
        </Campo>
        <Campo etiqueta="Troncal SIP">
          <select value={f.troncal_id ?? ""} onChange={(e) => setF({ ...f, troncal_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {troncales.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
          </select>
        </Campo>
      </div>
      <div className="rejilla c2">
        <Campo etiqueta="Agente para llamadas entrantes">
          <select value={f.agente_entrante_id ?? ""} onChange={(e) => setF({ ...f, agente_entrante_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Ninguno</option>
            {agentes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Tope de llamadas por día" ayuda="Protege el caller ID de quedar marcado como spam">
          <input type="number" min={1} value={f.tope_diario} onChange={(e) => setF({ ...f, tope_diario: Number(e.target.value) })} />
        </Campo>
      </div>
      <Check valor={f.activo} onCambio={(v) => setF({ ...f, activo: v })}>Activo para campañas</Check>
    </Modal>
  );
}

export default function CanalTelefonia() {
  const { puede } = useSesion();
  const avisar = useAvisos();
  const troncales = useCarga<Troncal[]>(() => api.get("/api/troncales"), []);
  const numeros = useCarga<Numero[]>(() => api.get("/api/numeros"), []);
  const agentes = useCarga<Agente[]>(() => api.get("/api/agentes"), []);
  const [editTroncal, setEditTroncal] = useState<Troncal | null | "nueva">(null);
  const [editNumero, setEditNumero] = useState<Numero | null | "nuevo">(null);
  const [importando, setImportando] = useState<number | null>(null);
  const admin = puede("admin");

  const borrarTroncal = async (t: Troncal) => {
    if (!confirm(`¿Eliminar la troncal ${t.nombre}?`)) return;
    await api.del(`/api/troncales/${t.id}`);
    troncales.recargar();
  };
  const borrarNumero = async (n: Numero) => {
    if (!confirm(`¿Eliminar ${n.numero}?`)) return;
    await api.del(`/api/numeros/${n.id}`);
    numeros.recargar();
  };
  const importar = async (n: Numero) => {
    setImportando(n.id);
    try {
      await api.post(`/api/numeros/${n.id}/importar-retell`);
      avisar(`${n.numero} importado a Retell`);
      numeros.recargar();
    } catch (e) {
      avisar((e as Error).message, true);
    } finally {
      setImportando(null);
    }
  };
  const nombreAgente = (id: number | null) => agentes.datos?.find((a) => a.id === id)?.nombre ?? "—";
  const nombreTroncal = (id: number | null) => troncales.datos?.find((t) => t.id === id)?.nombre ?? "—";

  if ((troncales.cargando && !troncales.datos) || (numeros.cargando && !numeros.datos)) return <Cargando />;
  return (
    <div className="pila">
      <Banner icono="tips_and_updates">
        En Colombia y México la contestación cae mucho con números +1: usa números locales (SIP trunk con un operador local
        es más barato y tiene mejor reputación). Agrega 2 o más números a cada campaña: Platzito rota el caller ID,
        prefiere el que coincide con el país del contacto y respeta el tope diario de cada número.
      </Banner>

      <Tarjeta titulo="Números" icono="dialpad" acciones={admin && <Boton variante="primario" chico icono="add" onClick={() => setEditNumero("nuevo")}>Agregar número</Boton>}>
        {(numeros.datos ?? []).length === 0 ? (
          <Vacio icono="call" titulo="Sin números">Agrega un número de tu troncal SIP e impórtalo a Retell para llamar con tus agentes.</Vacio>
        ) : (
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Número</th><th>Proveedor</th><th>Troncal</th><th>Entrantes</th><th>Uso 24 h</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {(numeros.datos ?? []).map((n) => {
                  const uso = Math.min(1, (n.usados_24h ?? 0) / Math.max(1, n.tope_diario));
                  return (
                    <tr key={n.id}>
                      <td><div className="mono">{n.numero}</div><div className="chico tenue">{n.etiqueta}</div></td>
                      <td>{n.proveedor.toUpperCase()}</td>
                      <td>{nombreTroncal(n.troncal_id)}</td>
                      <td>{nombreAgente(n.agente_entrante_id)}</td>
                      <td style={{ minWidth: 140 }}>
                        <div className="chico ds-numeric">{fmt.numero(n.usados_24h)} / {fmt.numero(n.tope_diario)}</div>
                        <div className="barra-h"><span style={{ width: `${uso * 100}%` }} /></div>
                      </td>
                      <td>
                        <div className="fila" style={{ gap: "var(--gap-4)" }}>
                          {n.activo ? <Insignia tono="ok">Activo</Insignia> : <Insignia>Inactivo</Insignia>}
                          {n.importado_retell ? <Insignia tono="primaria">En Retell</Insignia> : <Insignia tono="aviso">Sin importar</Insignia>}
                        </div>
                      </td>
                      <td>
                        {admin && (
                          <div className="acciones">
                            {!n.importado_retell && <Boton chico icono="upload" cargando={importando === n.id} onClick={() => importar(n)}>Importar a Retell</Boton>}
                            <Boton chico variante="texto" icono="edit" onClick={() => setEditNumero(n)} aria-label="Editar" />
                            <Boton chico variante="texto" icono="delete" onClick={() => borrarNumero(n)} aria-label="Eliminar" />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>

      <Tarjeta titulo="Troncales SIP" icono="settings_phone" acciones={admin && <Boton chico icono="add" onClick={() => setEditTroncal("nueva")}>Nueva troncal</Boton>}>
        {(troncales.datos ?? []).length === 0 ? (
          <p className="tenue">Sin troncales. Configura el host y las credenciales de tu operador para importar números a Retell.</p>
        ) : (
          <div className="tabla-env">
            <table className="tabla">
              <thead><tr><th>Nombre</th><th>Termination URI</th><th>Usuario</th><th className="num">Canales</th><th /></tr></thead>
              <tbody>
                {(troncales.datos ?? []).map((t) => (
                  <tr key={t.id}>
                    <td>{t.nombre}</td>
                    <td className="mono">{t.termination_uri}</td>
                    <td>{t.usuario || "—"} {t.tiene_clave && <Insignia>con clave</Insignia>}</td>
                    <td className="num">{t.canales}</td>
                    <td>{admin && (
                      <div className="acciones">
                        <Boton chico variante="texto" icono="edit" onClick={() => setEditTroncal(t)} aria-label="Editar" />
                        <Boton chico variante="texto" icono="delete" onClick={() => borrarTroncal(t)} aria-label="Eliminar" />
                      </div>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>

      {editTroncal && (
        <ModalTroncal troncal={editTroncal === "nueva" ? null : editTroncal} onCerrar={() => setEditTroncal(null)}
          onListo={() => { setEditTroncal(null); troncales.recargar(); }} />
      )}
      {editNumero && (
        <ModalNumero numero={editNumero === "nuevo" ? null : editNumero} troncales={troncales.datos ?? []} agentes={agentes.datos ?? []}
          onCerrar={() => setEditNumero(null)} onListo={() => { setEditNumero(null); numeros.recargar(); }} />
      )}
    </div>
  );
}
