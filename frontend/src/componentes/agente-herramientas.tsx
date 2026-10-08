// Pestaña Herramientas: lo que el agente puede hacer en la conversación, más las guardas deterministas.
import { useState } from "react";
import { api } from "../api";
import type { Herramienta, Plantilla, TipoHerramienta } from "../tipos";
import { Ayuda, Deslizador, EditorKV, EditorParametros, Num, type PropsPestana } from "./agente-comun";
import { Boton, Campo, Check, Icono, Insignia, ListaTextos, Tarjeta, useCarga } from "./ui";

export const TIPOS: Record<TipoHerramienta, { texto: string; icono: string; desc: string; soloVoz?: boolean }> = {
  buscar_conocimiento: { texto: "Buscar en conocimiento", icono: "psychology", desc: "Consulta los cerebros asignados antes de responder." },
  agendar_cita: { texto: "Agendar cita", icono: "event", desc: "Consulta horarios libres y agenda (interno o Cal.com)." },
  enviar_plantilla_whatsapp: { texto: "Enviar plantilla WhatsApp", icono: "chat", desc: "Envía una plantilla aprobada al contacto, incluso en plena llamada." },
  transferir_llamada: { texto: "Transferir llamada", icono: "phone_forwarded", desc: "Pasa la llamada a un número del equipo.", soloVoz: true },
  colgar: { texto: "Colgar", icono: "call_end", desc: "Termina la llamada tras despedirse.", soloVoz: true },
  escalar_humano: { texto: "Escalar a humano", icono: "support_agent", desc: "Pausa la IA y deja la conversación al equipo en el Inbox." },
  guardar_dato: { texto: "Guardar dato", icono: "save", desc: "Guarda datos del contacto en el CRM durante la conversación." },
  api: { texto: "API personalizada", icono: "api", desc: "Llama un endpoint externo; el modelo llena los parámetros." },
};

const DIAS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];

function nueva(tipo: TipoHerramienta): Herramienta {
  const base: Herramienta = { tipo, nombre: "", descripcion: "", activa: true, config: {}, parametros: [], mensaje_espera: "" };
  if (tipo === "agendar_cita") base.config = { proveedor: "interno", duracion_min: 30 };
  if (tipo === "api") base.config = { metodo: "POST", url: "", encabezados: {}, timeout_s: 10 };
  if (tipo === "api") base.nombre = "consultar_sistema";
  return base;
}

function Horario({ valor, onCambio, disabled }: { valor: Record<string, string[][]>; onCambio: (v: Record<string, string[][]>) => void; disabled: boolean }) {
  return (
    <div className="pila c">
      {DIAS.map((d) => {
        const franjas = valor[d] ?? [];
        return (
          <div key={d} className="fila" style={{ flexWrap: "nowrap" }}>
            <span className="mono" style={{ width: 36 }}>{d}</span>
            <div className="fila crece" style={{ gap: "var(--gap-8)" }}>
              {franjas.length === 0 && <span className="chico tenue">No disponible</span>}
              {franjas.map((f, i) => (
                <span key={i} className="fila" style={{ gap: 4, flexWrap: "nowrap" }}>
                  <input type="time" value={f[0]} disabled={disabled} style={{ width: 110 }}
                    onChange={(e) => onCambio({ ...valor, [d]: franjas.map((x, j) => (j === i ? [e.target.value, x[1]] : x)) })} />
                  –
                  <input type="time" value={f[1]} disabled={disabled} style={{ width: 110 }}
                    onChange={(e) => onCambio({ ...valor, [d]: franjas.map((x, j) => (j === i ? [x[0], e.target.value] : x)) })} />
                  {!disabled && <Boton chico icono="close" onClick={() => onCambio({ ...valor, [d]: franjas.filter((_, j) => j !== i) })} />}
                </span>
              ))}
            </div>
            {!disabled && <Boton chico icono="add" title="Agregar franja" onClick={() => onCambio({ ...valor, [d]: [...franjas, ["09:00", "17:00"]] })} />}
          </div>
        );
      })}
    </div>
  );
}

function ConfigHerramienta({ h, set, disabled, plantillas }: { h: Herramienta; set: (h: Herramienta) => void; disabled: boolean; plantillas: Plantilla[] }) {
  const c = h.config;
  const setC = (cambios: Record<string, unknown>) => set({ ...h, config: { ...c, ...cambios } });
  switch (h.tipo) {
    case "agendar_cita":
      return (
        <div className="pila">
          <div className="rejilla c3">
            <Campo etiqueta="Proveedor">
              <select value={c.proveedor ?? "interno"} disabled={disabled} onChange={(e) => setC({ proveedor: e.target.value })}>
                <option value="interno">Agenda interna</option>
                <option value="calcom">Cal.com</option>
              </select>
            </Campo>
            <Campo etiqueta="Duración (min)"><Num valor={c.duracion_min ?? 30} min={5} disabled={disabled} onCambio={(v) => setC({ duracion_min: v })} /></Campo>
            <Campo etiqueta="Zona horaria" ayuda="Vacío = la del contacto o del espacio">
              <input type="text" value={c.zona_horaria ?? ""} disabled={disabled} placeholder="America/Bogota" onChange={(e) => setC({ zona_horaria: e.target.value })} />
            </Campo>
          </div>
          {c.proveedor === "calcom" ? (
            <Campo etiqueta="Event type ID de Cal.com" ayuda="La API key de Cal.com se configura en Ajustes → Integraciones.">
              <input type="text" value={c.event_type_id ?? ""} disabled={disabled} onChange={(e) => setC({ event_type_id: e.target.value })} />
            </Campo>
          ) : (
            <>
              <Campo etiqueta="Antelación mínima (horas)"><Num valor={c.antelacion_h ?? 2} min={0} disabled={disabled} onCambio={(v) => setC({ antelacion_h: v })} /></Campo>
              <Campo etiqueta="Horario disponible" ayuda="Vacío = lunes a viernes de 9:00 a 17:00.">
                <Horario valor={c.horario ?? {}} disabled={disabled} onCambio={(v) => setC({ horario: v })} />
              </Campo>
            </>
          )}
        </div>
      );
    case "enviar_plantilla_whatsapp": {
      const p = plantillas.find((x) => x.id === Number(c.plantilla_id));
      return (
        <div className="pila">
          <Campo etiqueta="Plantilla aprobada">
            <select value={c.plantilla_id ?? ""} disabled={disabled} onChange={(e) => setC({ plantilla_id: Number(e.target.value) || null })}>
              <option value="">Elige una plantilla…</option>
              {plantillas.map((x) => (
                <option key={x.id} value={x.id} disabled={x.estado !== "APPROVED"}>{x.nombre} ({x.idioma}) · {x.estado}</option>
              ))}
            </select>
          </Campo>
          {p && <pre className="tarjeta plana chico">{p.cuerpo}</pre>}
          <Campo etiqueta={`Valores de las variables {{1}}, {{2}}… ${p ? `(${p.n_variables})` : ""}`}
            ayuda="Puedes usar {{nombre}} del contacto o el nombre de un parámetro que llene el modelo.">
            <ListaTextos valor={c.variables ?? []} onCambio={(v) => !disabled && setC({ variables: v })} placeholder="{{primer_nombre}}" />
          </Campo>
          <Campo etiqueta="Parámetros que llena el modelo (opcional)">
            <EditorParametros valor={h.parametros} disabled={disabled} onCambio={(v) => set({ ...h, parametros: v })} />
          </Campo>
        </div>
      );
    }
    case "transferir_llamada":
      return (
        <Campo etiqueta="Número de destino" ayuda="Vacío = el número de transferencia de la pestaña Voz.">
          <input type="tel" value={c.numero ?? ""} disabled={disabled} placeholder="+5716000000" onChange={(e) => setC({ numero: e.target.value })} />
        </Campo>
      );
    case "guardar_dato":
      return (
        <Campo etiqueta="Datos a guardar" ayuda="Sin parámetros, el modelo guarda pares campo/valor libres.">
          <EditorParametros valor={h.parametros} disabled={disabled} onCambio={(v) => set({ ...h, parametros: v })} />
        </Campo>
      );
    case "api":
      return (
        <div className="pila">
          <div className="fila" style={{ flexWrap: "nowrap" }}>
            <select value={c.metodo ?? "POST"} disabled={disabled} style={{ width: 110 }} onChange={(e) => setC({ metodo: e.target.value })}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
            </select>
            <input type="url" className="mono" value={c.url ?? ""} disabled={disabled} placeholder="https://api.tuempresa.com/pedidos/{{numero_pedido}}"
              onChange={(e) => setC({ url: e.target.value })} />
            <span style={{ width: 120 }}><Num valor={c.timeout_s ?? 10} min={1} max={60} disabled={disabled} onCambio={(v) => setC({ timeout_s: v })} /></span>
          </div>
          <Campo etiqueta="Encabezados">
            <EditorKV valor={c.encabezados ?? {}} disabled={disabled} placeholderClave="Authorization" onCambio={(v) => setC({ encabezados: v })} />
          </Campo>
          {c.metodo !== "GET" && (
            <Campo etiqueta="Plantilla del cuerpo JSON (opcional)" ayuda='Ej.: {"email": "{{email}}", "pedido": "{{numero_pedido}}"}. Vacío = se envían los parámetros tal cual.'>
              <textarea className="codigo" rows={4} value={c.cuerpo_plantilla ?? ""} disabled={disabled} onChange={(e) => setC({ cuerpo_plantilla: e.target.value })} />
            </Campo>
          )}
          <Campo etiqueta="Parámetros que llena el modelo">
            <EditorParametros valor={h.parametros} disabled={disabled} onCambio={(v) => set({ ...h, parametros: v })} />
          </Campo>
        </div>
      );
    default:
      return null;
  }
}

export default function PestanaHerramientas({ cfg, setCfg, editable }: PropsPestana) {
  const plantillas = useCarga(() => api.get<Plantilla[]>("/api/plantillas").catch(() => []));
  const [abierta, setAbierta] = useState<number | null>(null);
  const herramientas = cfg.herramientas;
  const setH = (i: number, h: Herramienta) => setCfg({ ...cfg, herramientas: herramientas.map((x, j) => (j === i ? h : x)) });
  const agregar = (t: TipoHerramienta) => {
    setCfg({ ...cfg, herramientas: [...herramientas, nueva(t)] });
    setAbierta(herramientas.length);
  };
  const tiposUsados = new Set(herramientas.map((h) => h.tipo));
  const g = cfg.guardas;

  return (
    <div className="pila">
      <Tarjeta titulo="Herramientas del agente" icono="construction">
        <div className="pila c">
          {herramientas.length === 0 && <span className="tenue">El agente solo conversa: agrega herramientas para que actúe.</span>}
          {herramientas.map((h, i) => {
            const t = TIPOS[h.tipo];
            const sinCerebro = h.tipo === "buscar_conocimiento" && cfg.conocimiento.cerebro_ids.length === 0;
            return (
              <div key={i} className="tarjeta plana" style={{ padding: "var(--padding-12)" }}>
                <div className="fila e" style={{ flexWrap: "nowrap" }}>
                  <div className="fila crece" style={{ cursor: "pointer", flexWrap: "nowrap" }} onClick={() => setAbierta(abierta === i ? null : i)}>
                    <Icono n={t.icono} />
                    <div className="crece">
                      <div style={{ fontWeight: 600 }}>
                        {t.texto}{h.nombre && h.nombre !== h.tipo ? <span className="mono tenue"> · {h.nombre}</span> : null}
                      </div>
                      <div className="chico tenue">{h.descripcion || t.desc}</div>
                    </div>
                    {t.soloVoz && <Insignia tono="info">Solo voz</Insignia>}
                    {sinCerebro && <Insignia tono="aviso">Sin cerebros asignados</Insignia>}
                    {!h.activa && <Insignia>Inactiva</Insignia>}
                  </div>
                  <Check valor={h.activa} onCambio={(v) => editable && setH(i, { ...h, activa: v })}>Activa</Check>
                  {editable && <Boton chico icono="delete" title="Quitar" onClick={() => setCfg({ ...cfg, herramientas: herramientas.filter((_, j) => j !== i) })} />}
                  <Boton chico icono={abierta === i ? "expand_less" : "expand_more"} onClick={() => setAbierta(abierta === i ? null : i)} />
                </div>
                {abierta === i && (
                  <div className="pila" style={{ marginTop: "var(--gap-16)" }}>
                    <div className="rejilla c2">
                      <Campo etiqueta="Nombre para el modelo" ayuda="Vacío = nombre por defecto">
                        <input type="text" className="mono" value={h.nombre} disabled={!editable}
                          onChange={(e) => setH(i, { ...h, nombre: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_") })} />
                      </Campo>
                      <Campo etiqueta="Frase de espera (voz)" ayuda="Lo que dice mientras corre, p. ej. «Déjame revisar…»">
                        <input type="text" value={h.mensaje_espera} disabled={!editable} onChange={(e) => setH(i, { ...h, mensaje_espera: e.target.value })} />
                      </Campo>
                    </div>
                    <Campo etiqueta="Cuándo usarla" ayuda="Vacío = descripción por defecto. Sé concreto: el modelo decide con este texto.">
                      <textarea rows={2} value={h.descripcion} disabled={!editable} placeholder={t.desc} onChange={(e) => setH(i, { ...h, descripcion: e.target.value })} />
                    </Campo>
                    <ConfigHerramienta h={h} disabled={!editable} plantillas={plantillas.datos ?? []} set={(x) => setH(i, x)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {editable && (
          <div className="fila" style={{ marginTop: "var(--gap-16)", gap: "var(--gap-8)" }}>
            {(Object.keys(TIPOS) as TipoHerramienta[]).map((t) => (
              <Boton key={t} chico icono={TIPOS[t].icono} disabled={t !== "api" && t !== "guardar_dato" && tiposUsados.has(t)} onClick={() => agregar(t)}>
                {TIPOS[t].texto}
              </Boton>
            ))}
          </div>
        )}
      </Tarjeta>

      <Tarjeta titulo="Guardas deterministas" icono="shield">
        <Ayuda>Reglas que se aplican aunque el modelo se equivoque. Además, el texto que parece una llamada a herramienta escrita a mano nunca se envía al contacto.</Ayuda>
        <div className="pila c" style={{ marginTop: "var(--gap-12)" }}>
          <Check valor={g.escalar_si_pide_humano} onCambio={(v) => editable && setCfg({ ...cfg, guardas: { ...g, escalar_si_pide_humano: v } })}>
            Escalar a humano si el contacto lo pide, aunque el modelo no lo haga
          </Check>
          <Check valor={g.colgar_en_despedida} onCambio={(v) => editable && setCfg({ ...cfg, guardas: { ...g, colgar_en_despedida: v } })}>
            En voz, colgar cuando ambos se despiden
          </Check>
          <Campo etiqueta="Máximo de rondas de herramientas por turno">
            <Deslizador valor={g.max_rondas_herramientas} min={1} max={8} paso={1} disabled={!editable}
              onCambio={(v) => setCfg({ ...cfg, guardas: { ...g, max_rondas_herramientas: v } })} />
          </Campo>
        </div>
      </Tarjeta>
    </div>
  );
}
