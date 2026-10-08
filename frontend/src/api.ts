// Cliente HTTP de la API de Platzito. Agrega el token y el espacio activo a cada petición.

const CLAVE_TOKEN = "platzito.token";
const CLAVE_ESPACIO = "platzito.espacio";

export class ErrorApi extends Error {
  constructor(public estado: number, mensaje: string, public detalle?: unknown) {
    super(mensaje);
  }
}

function leer(clave: string): string | null {
  try {
    return localStorage.getItem(clave);
  } catch {
    return null;
  }
}

function escribir(clave: string, valor: string | null) {
  try {
    if (valor === null) localStorage.removeItem(clave);
    else localStorage.setItem(clave, valor);
  } catch {
    /* almacenamiento bloqueado: la sesión dura lo que dure la pestaña */
  }
}

export const sesionLocal = {
  token: () => leer(CLAVE_TOKEN),
  espacio: () => leer(CLAVE_ESPACIO),
  guardar(token: string, espacio?: number) {
    escribir(CLAVE_TOKEN, token);
    if (espacio !== undefined) escribir(CLAVE_ESPACIO, String(espacio));
  },
  cambiarEspacio(espacio: number) {
    escribir(CLAVE_ESPACIO, String(espacio));
  },
  salir() {
    escribir(CLAVE_TOKEN, null);
    escribir(CLAVE_ESPACIO, null);
  },
};

function mensajeDe(detalle: unknown, estado: number): string {
  if (typeof detalle === "string") return detalle;
  if (Array.isArray(detalle))
    return detalle
      .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg ?? ""}`)
      .join(" · ");
  return `Error ${estado}`;
}

let alExpirar: () => void = () => {};
export function alCerrarSesion(fn: () => void) {
  alExpirar = fn;
}

async function pedir<T>(metodo: string, ruta: string, cuerpo?: unknown, opciones: { formulario?: boolean } = {}): Promise<T> {
  const cabeceras: Record<string, string> = {};
  const token = sesionLocal.token();
  const espacio = sesionLocal.espacio();
  if (token) cabeceras.authorization = `Bearer ${token}`;
  if (espacio) cabeceras["x-espacio"] = espacio;
  let body: BodyInit | undefined;
  if (cuerpo !== undefined) {
    if (opciones.formulario) body = cuerpo as FormData;
    else {
      cabeceras["content-type"] = "application/json";
      body = JSON.stringify(cuerpo);
    }
  }
  const r = await fetch(ruta, { method: metodo, headers: cabeceras, body });
  if (r.status === 401 && token && !ruta.startsWith("/api/auth/login")) {
    alExpirar();
  }
  const tipo = r.headers.get("content-type") ?? "";
  const datos = tipo.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) {
    const detalle = typeof datos === "object" && datos ? (datos as { detail?: unknown }).detail : datos;
    throw new ErrorApi(r.status, mensajeDe(detalle, r.status), detalle);
  }
  return datos as T;
}

export const api = {
  get: <T = any>(ruta: string) => pedir<T>("GET", ruta),
  post: <T = any>(ruta: string, cuerpo: unknown = {}) => pedir<T>("POST", ruta, cuerpo),
  put: <T = any>(ruta: string, cuerpo: unknown = {}) => pedir<T>("PUT", ruta, cuerpo),
  patch: <T = any>(ruta: string, cuerpo: unknown = {}) => pedir<T>("PATCH", ruta, cuerpo),
  del: <T = any>(ruta: string) => pedir<T>("DELETE", ruta),
  subir: <T = any>(ruta: string, formulario: FormData) => pedir<T>("POST", ruta, formulario, { formulario: true }),
  /** Descarga autenticada (p. ej. CSV) */
  async descargar(ruta: string, nombre: string) {
    const r = await fetch(ruta, {
      headers: { authorization: `Bearer ${sesionLocal.token() ?? ""}`, "x-espacio": sesionLocal.espacio() ?? "" },
    });
    if (!r.ok) throw new ErrorApi(r.status, "No se pudo descargar");
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/** Construye un querystring omitiendo valores vacíos. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
