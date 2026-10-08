// Contexto de sesión: usuario, espacios, espacio activo y rol.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { alCerrarSesion, api, sesionLocal } from "./api";
import { NIVEL_ROL, type Espacio, type Rol, type Sesion } from "./tipos";

interface Ctx {
  sesion: Sesion | null;
  espacio: Espacio | null;
  listo: boolean;
  entrar: (s: Sesion) => void;
  salir: () => void;
  cambiarEspacio: (id: number) => void;
  recargarEspacio: () => Promise<void>;
  puede: (rol: Rol) => boolean;
}

const C = createContext<Ctx>(null as unknown as Ctx);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [espacio, setEspacio] = useState<Espacio | null>(null);
  const [listo, setListo] = useState(false);

  const salir = useCallback(() => {
    sesionLocal.salir();
    setSesion(null);
    setEspacio(null);
  }, []);

  const recargarEspacio = useCallback(async () => {
    try {
      setEspacio(await api.get<Espacio>("/api/espacio"));
    } catch {
      /* sin espacio: la sesión se invalida en el manejador de 401 */
    }
  }, []);

  const entrar = useCallback((s: Sesion) => {
    const actual = Number(sesionLocal.espacio());
    const espacioId = s.espacios.some((e) => e.id === actual) ? actual : s.espacios[0]?.id;
    sesionLocal.guardar(s.token, espacioId);
    setSesion(s);
  }, []);

  useEffect(() => {
    alCerrarSesion(salir);
    if (!sesionLocal.token()) {
      setListo(true);
      return;
    }
    api.get<Sesion>("/api/auth/yo")
      .then(entrar)
      .catch(salir)
      .finally(() => setListo(true));
  }, [entrar, salir]);

  useEffect(() => {
    if (sesion) recargarEspacio();
  }, [sesion, recargarEspacio]);

  const cambiarEspacio = (id: number) => {
    sesionLocal.cambiarEspacio(id);
    window.location.assign("/");
  };

  const puede = (rol: Rol) => !!espacio && NIVEL_ROL[espacio.rol] >= NIVEL_ROL[rol];

  return (
    <C.Provider value={{ sesion, espacio, listo, entrar, salir, cambiarEspacio, recargarEspacio, puede }}>
      {children}
    </C.Provider>
  );
}

export const useSesion = () => useContext(C);
