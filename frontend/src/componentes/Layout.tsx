import { Component, Suspense, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useSesion } from "../sesion";
import { Boton, Cargando, Icono, Vacio } from "./ui";

/** Si una página falla al renderizar, se muestra el error sin tumbar la navegación. */
class LimiteError extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Vacio icono="error" titulo="Algo falló en esta página" accion={<Boton onClick={() => window.location.reload()}>Recargar</Boton>}>
        <code className="chico">{this.state.error.message}</code>
      </Vacio>
    );
  }
}

const NAV: { a: string; texto: string; icono: string }[] = [
  { a: "/", texto: "Panel", icono: "monitoring" },
  { a: "/inbox", texto: "Inbox", icono: "forum" },
  { a: "/agentes", texto: "Agentes", icono: "smart_toy" },
  { a: "/conocimiento", texto: "Conocimiento", icono: "psychology" },
  { a: "/secuencias", texto: "Campañas", icono: "campaign" },
  { a: "/contactos", texto: "Contactos", icono: "contacts" },
  { a: "/llamadas", texto: "Llamadas", icono: "call_log" },
];
const NAV2: { a: string; texto: string; icono: string }[] = [
  { a: "/canales", texto: "Canales", icono: "hub" },
  { a: "/ajustes", texto: "Ajustes", icono: "settings" },
];

export default function Layout() {
  const { sesion, espacio, salir, cambiarEspacio } = useSesion();
  const { pathname } = useLocation();
  return (
    <div className="app">
      <nav className="lateral" aria-label="Navegación principal">
        <div className="marca">
          <img src="/platzi-logo.png" alt="" />
          <b>Platzito</b>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.a} to={n.a} end={n.a === "/"} className={({ isActive }) => `nav-item ${isActive ? "activo" : ""}`}>
            <Icono n={n.icono} />
            {n.texto}
          </NavLink>
        ))}
        <div className="nav-sep" />
        {NAV2.map((n) => (
          <NavLink key={n.a} to={n.a} className={({ isActive }) => `nav-item ${isActive ? "activo" : ""}`}>
            <Icono n={n.icono} />
            {n.texto}
          </NavLink>
        ))}
        <div className="lateral-pie">
          {sesion && sesion.espacios.length > 1 ? (
            <select value={espacio?.id ?? ""} onChange={(e) => cambiarEspacio(Number(e.target.value))} aria-label="Espacio">
              {sesion.espacios.map((e) => (
                <option key={e.id} value={e.id}>{e.nombre}</option>
              ))}
            </select>
          ) : (
            <div className="chico tenue trunc" style={{ padding: "0 var(--padding-12)" }}>{espacio?.nombre}</div>
          )}
          <div className="fila e" style={{ padding: "0 var(--padding-4) 0 var(--padding-12)" }}>
            <div className="crece">
              <div className="trunc" style={{ fontWeight: 600 }}>{sesion?.usuario.nombre}</div>
              <div className="chico tenue trunc">{espacio?.rol}</div>
            </div>
            <button className="btn texto icono" onClick={salir} title="Cerrar sesión" aria-label="Cerrar sesión">
              <Icono n="logout" />
            </button>
          </div>
        </div>
      </nav>
      <main className="contenido">
        <LimiteError key={pathname}>
          <Suspense fallback={<Cargando />}>
            <Outlet />
          </Suspense>
        </LimiteError>
      </main>
    </div>
  );
}
