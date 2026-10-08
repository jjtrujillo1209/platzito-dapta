import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./componentes/Layout";
import { Cargando } from "./componentes/ui";
import { Invitacion, Login, Registro } from "./paginas/Acceso";
import { useSesion } from "./sesion";

// Cada página es su propio chunk: el bundle inicial solo trae el layout y el acceso.
const Agentes = lazy(() => import("./paginas/Agentes"));
const AgenteEditor = lazy(() => import("./paginas/AgenteEditor"));
const Ajustes = lazy(() => import("./paginas/Ajustes"));
const Canales = lazy(() => import("./paginas/Canales"));
const Conocimiento = lazy(() => import("./paginas/Conocimiento"));
const Contactos = lazy(() => import("./paginas/Contactos"));
const Inbox = lazy(() => import("./paginas/Inbox"));
const Llamadas = lazy(() => import("./paginas/Llamadas"));
const Panel = lazy(() => import("./paginas/Panel"));
const SecuenciaDetalle = lazy(() => import("./paginas/SecuenciaDetalle"));
const Secuencias = lazy(() => import("./paginas/Secuencias"));

export default function App() {
  const { sesion, listo } = useSesion();
  if (!listo) return <Cargando />;
  return (
    <Routes>
      <Route path="/entrar" element={<Login />} />
      <Route path="/registro" element={<Registro />} />
      <Route path="/invitacion/:token" element={<Invitacion />} />
      {sesion ? (
        <Route element={<Layout />}>
          <Route index element={<Panel />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:id" element={<Inbox />} />
          <Route path="agentes" element={<Agentes />} />
          <Route path="agentes/:id" element={<AgenteEditor />} />
          <Route path="conocimiento" element={<Conocimiento />} />
          <Route path="conocimiento/:id" element={<Conocimiento />} />
          <Route path="secuencias" element={<Secuencias />} />
          <Route path="secuencias/:id" element={<SecuenciaDetalle />} />
          <Route path="contactos" element={<Contactos />} />
          <Route path="contactos/:id" element={<Contactos />} />
          <Route path="llamadas" element={<Llamadas />} />
          <Route path="canales" element={<Canales />} />
          <Route path="ajustes" element={<Ajustes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/entrar" replace />} />
      )}
    </Routes>
  );
}
