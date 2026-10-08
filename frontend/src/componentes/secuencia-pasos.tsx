// Constructor visual de pasos de una campaña.
import type { Agente, Paso, Plantilla, TipoPaso } from "../tipos";
import { CONDICIONES, pasoVacio, textoEspera, TIPOS_PASO } from "./secuencia-comun";
import { Banner, Boton, Campo, Check, Icono } from "./ui";

const UNIDADES = [
  { id: "min", texto: "minutos", factor: 1 },
  { id: "h", texto: "horas", factor: 60 },
  { id: "d", texto: "días", factor: 1440 },
];

function EntradaEspera({ valor, onCambio }: { valor: number; onCambio: (v: number) => void }) {
  const unidad = valor && valor % 1440 === 0 ? UNIDADES[2] : valor && valor % 60 === 0 ? UNIDADES[1] : UNIDADES[0];
  return (
    <div className="fila" style={{ gap: "var(--gap-4)", flexWrap: "nowrap" }}>
      <input type="number" min={0} value={valor / unidad.factor} style={{ width: 90 }}
        onChange={(e) => onCambio(Math.max(0, Math.round(Number(e.target.value) * unidad.factor)))} />
      <select value={unidad.id} style={{ width: 110 }}
        onChange={(e) => { const u = UNIDADES.find((x) => x.id === e.target.value)!; onCambio(Math.round((valor / unidad.factor) * u.factor)); }}>
        {UNIDADES.map((u) => <option key={u.id} value={u.id}>{u.texto}</option>)}
      </select>
    </div>
  );
}

function variablesDe(cuerpo: string): number {
  return new Set(Array.from(cuerpo.matchAll(/\{\{(\d+)\}\}/g)).map((m) => m[1])).size;
}

function SelectorPlantilla({ valor, onCambio, plantillas, vacio = "Elige una plantilla" }: {
  valor: number | null; onCambio: (id: number | null) => void; plantillas: Plantilla[]; vacio?: string;
}) {
  return (
    <select value={valor ?? ""} onChange={(e) => onCambio(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{vacio}</option>
      {plantillas.map((p) => (
        <option key={p.id} value={p.id} disabled={p.estado !== "APPROVED"}>
          {p.nombre} ({p.idioma}) · {p.categoria}{p.estado !== "APPROVED" ? ` · ${p.estado}` : ""}
        </option>
      ))}
    </select>
  );
}

function EditorPaso({ paso, i, total, onCambio, onMover, onQuitar, agentes, plantillas, soloLectura }: {
  paso: Paso; i: number; total: number; onCambio: (p: Paso) => void; onMover: (d: -1 | 1) => void; onQuitar: () => void;
  agentes: Agente[]; plantillas: Plantilla[]; soloLectura: boolean;
}) {
  const set = <K extends keyof Paso>(k: K, v: Paso[K]) => onCambio({ ...paso, [k]: v });
  const plantilla = plantillas.find((p) => p.id === paso.plantilla_id);
  const nVars = plantilla ? Math.max(plantilla.n_variables, variablesDe(plantilla.cuerpo)) : 0;
  return (
    <div className="tarjeta" style={{ position: "relative" }}>
      <fieldset disabled={soloLectura} style={{ border: "none", padding: 0, margin: 0 }} className="pila">
        <div className="fila e">
          <div className="fila">
            <span className="insignia primaria"><Icono n={TIPOS_PASO[paso.tipo].icono} /> Paso {i + 1}</span>
            <select value={paso.tipo} style={{ width: 150 }} onChange={(e) => onCambio({ ...pasoVacio(e.target.value as TipoPaso), espera_min: paso.espera_min, condicion: paso.condicion })}>
              {(Object.keys(TIPOS_PASO) as TipoPaso[]).map((t) => <option key={t} value={t}>{TIPOS_PASO[t].texto}</option>)}
            </select>
          </div>
          <div className="acciones">
            <Boton chico icono="arrow_upward" variante="texto" disabled={i === 0} onClick={() => onMover(-1)} aria-label="Subir" />
            <Boton chico icono="arrow_downward" variante="texto" disabled={i === total - 1} onClick={() => onMover(1)} aria-label="Bajar" />
            <Boton chico icono="delete" variante="texto" onClick={onQuitar} aria-label="Quitar paso" />
          </div>
        </div>
        <div className="rejilla c2">
          <Campo etiqueta={i === 0 ? "Espera desde la inscripción" : "Espera desde el paso anterior"} ayuda={textoEspera(paso.espera_min)}>
            <EntradaEspera valor={paso.espera_min} onCambio={(v) => set("espera_min", v)} />
          </Campo>
          <Campo etiqueta="Condición">
            <select value={paso.condicion} onChange={(e) => set("condicion", e.target.value as Paso["condicion"])}>
              {Object.entries(CONDICIONES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Campo>
        </div>

        {paso.tipo === "llamada" && (
          <>
            <div className="rejilla c4">
              <Campo etiqueta="Agente" ayuda="Vacío = el del A/B">
                <select value={paso.agente_id ?? ""} onChange={(e) => set("agente_id", e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Según A/B</option>
                  {agentes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                </select>
              </Campo>
              <Campo etiqueta="Intentos máximos" ayuda="1–40 (recomendado 3)">
                <input type="number" min={1} max={40} value={paso.max_intentos} onChange={(e) => set("max_intentos", Number(e.target.value))} />
              </Campo>
              <Campo etiqueta="Intentos por día" ayuda="1–5 (recomendado 1)">
                <input type="number" min={1} max={5} value={paso.intentos_por_dia} onChange={(e) => set("intentos_por_dia", Number(e.target.value))} />
              </Campo>
              <Campo etiqueta="Entre reintentos" ayuda={textoEspera(paso.reintento_min)}>
                <EntradaEspera valor={paso.reintento_min} onCambio={(v) => set("reintento_min", Math.max(5, v))} />
              </Campo>
            </div>
            <Check valor={paso.whatsapp_tras_intento !== null}
              onCambio={(v) => onCambio({ ...paso, whatsapp_tras_intento: v ? 1 : null, plantilla_fallback_id: v ? paso.plantilla_fallback_id : null })}>
              Enviar una plantilla de WhatsApp si no contesta (fallback)
            </Check>
            {paso.whatsapp_tras_intento !== null && (
              <div className="rejilla c2">
                <Campo etiqueta="Después del intento n.º" ayuda="Solo si nunca conectó en ningún intento">
                  <input type="number" min={1} max={paso.max_intentos} value={paso.whatsapp_tras_intento}
                    onChange={(e) => set("whatsapp_tras_intento", Number(e.target.value))} />
                </Campo>
                <Campo etiqueta="Plantilla del fallback">
                  <SelectorPlantilla valor={paso.plantilla_fallback_id} plantillas={plantillas} onCambio={(v) => set("plantilla_fallback_id", v)} />
                </Campo>
              </div>
            )}
          </>
        )}

        {paso.tipo === "whatsapp" && (
          <>
            <Campo etiqueta="Plantilla aprobada" ayuda="Fuera de la ventana de 24 h Meta solo acepta plantillas aprobadas.">
              <SelectorPlantilla valor={paso.plantilla_id} plantillas={plantillas}
                onCambio={(v) => onCambio({ ...paso, plantilla_id: v, variables: [] })} />
            </Campo>
            {plantilla && (
              <div className="tarjeta plana pila c">
                <span className="chico tenue">Vista previa</span>
                <pre style={{ fontFamily: "var(--font-body)" }}>{plantilla.cuerpo}</pre>
              </div>
            )}
            {nVars > 0 && (
              <div className="rejilla c3">
                {Array.from({ length: nVars }, (_, k) => (
                  <Campo key={k} etiqueta={`{{${k + 1}}}`} ayuda={k === 0 ? "Usa {{nombre}}, {{primer_nombre}}, {{empresa}} o atributos" : undefined}>
                    <input type="text" value={paso.variables[k] ?? ""} placeholder="{{primer_nombre}}"
                      onChange={(e) => { const v = [...paso.variables]; while (v.length < nVars) v.push(""); v[k] = e.target.value; set("variables", v); }} />
                  </Campo>
                ))}
              </div>
            )}
            <Campo etiqueta="Texto libre (opcional)" ayuda="Se usa en lugar de la plantilla solo si el contacto escribió en las últimas 24 h.">
              <textarea rows={2} value={paso.texto} onChange={(e) => set("texto", e.target.value)} placeholder="Hola {{primer_nombre}}, …" />
            </Campo>
          </>
        )}

        {paso.tipo === "correo" && (
          <>
            <Campo etiqueta="Asunto"><input type="text" value={paso.asunto} onChange={(e) => set("asunto", e.target.value)} /></Campo>
            <Campo etiqueta="Cuerpo" ayuda="Admite variables como {{nombre}} y {{empresa}}.">
              <textarea rows={5} value={paso.cuerpo} onChange={(e) => set("cuerpo", e.target.value)} />
            </Campo>
          </>
        )}

        {paso.tipo === "esperar" && <p className="tenue chico" style={{ margin: 0 }}>Solo espera el tiempo indicado antes del siguiente paso.</p>}
      </fieldset>
    </div>
  );
}

export default function PasosSecuencia({ pasos, onCambio, agentes, plantillas, soloLectura }: {
  pasos: Paso[]; onCambio: (p: Paso[]) => void; agentes: Agente[]; plantillas: Plantilla[]; soloLectura: boolean;
}) {
  const mover = (i: number, d: -1 | 1) => {
    const n = [...pasos];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    onCambio(n);
  };
  return (
    <div className="pila">
      <Banner icono="alt_route">
        Un solo motor para todos los canales: el "fallback" es simplemente el siguiente paso con una condición. Por
        ejemplo, <b>Llamada ×3 → WhatsApp (solo si nunca contestó) → espera 1 día → Llamada (solo si no ha respondido)</b>.
        Las franjas horarias, el cooldown de 1 h entre llamadas y los topes de WhatsApp se aplican solos.
      </Banner>
      {pasos.map((p, i) => (
        <div key={i} className="pila c">
          {i > 0 && (
            <div className="fila tenue chico" style={{ justifyContent: "center" }}>
              <Icono n="south" /> {p.espera_min ? `espera ${textoEspera(p.espera_min)}` : "a continuación"}
              {p.condicion !== "siempre" && <> · {CONDICIONES[p.condicion].toLowerCase()}</>}
            </div>
          )}
          <EditorPaso paso={p} i={i} total={pasos.length} agentes={agentes} plantillas={plantillas} soloLectura={soloLectura}
            onCambio={(np) => onCambio(pasos.map((x, j) => (j === i ? np : x)))}
            onMover={(d) => mover(i, d)} onQuitar={() => onCambio(pasos.filter((_, j) => j !== i))} />
        </div>
      ))}
      {!soloLectura && (
        <div className="fila" style={{ justifyContent: "center" }}>
          {(Object.keys(TIPOS_PASO) as TipoPaso[]).map((t) => (
            <Boton key={t} variante="contorno" icono={TIPOS_PASO[t].icono} onClick={() => onCambio([...pasos, pasoVacio(t)])}>
              + {TIPOS_PASO[t].texto}
            </Boton>
          ))}
        </div>
      )}
    </div>
  );
}
