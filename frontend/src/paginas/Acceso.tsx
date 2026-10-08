// Inicio de sesión, registro y aceptación de invitaciones.
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Banner, Boton, Campo } from "../componentes/ui";
import { useSesion } from "../sesion";
import type { Sesion } from "../tipos";

function Marco({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-arte">
        <img src="/shapes-stack.svg" alt="" className="formas" />
        <h1>Agentes que venden y atienden por WhatsApp, voz y web.</h1>
        <p className="ds-body-lg tenue">
          Un solo cerebro para todos los canales, campañas multicanal con protección de líneas y un simulador para
          probar antes de gastar una sola llamada.
        </p>
      </div>
      <div className="auth-form">{children}</div>
    </div>
  );
}

export function Login() {
  const { entrar, sesion } = useSesion();
  const [email, setEmail] = useState("");
  const [clave, setClave] = useState("");
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  if (sesion) return <Navigate to="/" replace />;
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setCargando(true);
    setError("");
    try {
      entrar(await api.post<Sesion>("/api/auth/login", { email, clave }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCargando(false);
    }
  };
  return (
    <Marco>
      <form onSubmit={enviar}>
        <div className="marca" style={{ padding: 0 }}>
          <img src="/platzi-logo.png" alt="" style={{ width: 32 }} />
          <b>Platzito</b>
        </div>
        <h2 className="ds-headline-sm">Inicia sesión</h2>
        {error && <Banner tono="error" icono="error">{error}</Banner>}
        <Campo etiqueta="Correo">
          <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Campo>
        <Campo etiqueta="Contraseña">
          <input type="password" required value={clave} onChange={(e) => setClave(e.target.value)} />
        </Campo>
        <button className="btn primario" type="submit" disabled={cargando}>Entrar</button>
        <p className="tenue">¿No tienes cuenta? <Link to="/registro">Crea tu espacio</Link></p>
      </form>
    </Marco>
  );
}

export function Registro() {
  const { entrar, sesion } = useSesion();
  const [f, setF] = useState({ nombre: "", email: "", clave: "", espacio: "", zona_horaria: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  if (sesion) return <Navigate to="/" replace />;
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setCargando(true);
    setError("");
    try {
      entrar(await api.post<Sesion>("/api/auth/registro", f));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCargando(false);
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Marco>
      <form onSubmit={enviar}>
        <h2 className="ds-headline-sm">Crea tu espacio</h2>
        {error && <Banner tono="error" icono="error">{error}</Banner>}
        <Campo etiqueta="Tu nombre"><input type="text" required value={f.nombre} onChange={set("nombre")} /></Campo>
        <Campo etiqueta="Empresa"><input type="text" required value={f.espacio} onChange={set("espacio")} /></Campo>
        <Campo etiqueta="Correo"><input type="email" required value={f.email} onChange={set("email")} /></Campo>
        <Campo etiqueta="Contraseña" ayuda="Mínimo 8 caracteres"><input type="password" required minLength={8} value={f.clave} onChange={set("clave")} /></Campo>
        <Boton variante="primario" type="submit" cargando={cargando}>Crear cuenta</Boton>
        <p className="tenue">¿Ya tienes cuenta? <Link to="/entrar">Inicia sesión</Link></p>
      </form>
    </Marco>
  );
}

export function Invitacion() {
  const { token } = useParams();
  const { entrar } = useSesion();
  const navegar = useNavigate();
  const [info, setInfo] = useState<{ email: string; rol: string; espacio: string; tiene_cuenta: boolean } | null>(null);
  const [error, setError] = useState("");
  const [nombre, setNombre] = useState("");
  const [clave, setClave] = useState("");
  useEffect(() => {
    api.get(`/api/invitaciones/${token}`).then(setInfo).catch((e) => setError(e.message));
  }, [token]);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    try {
      entrar(await api.post<Sesion>(`/api/invitaciones/${token}/aceptar`, { nombre, clave }));
      navegar("/");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Marco>
      <form onSubmit={enviar}>
        <h2 className="ds-headline-sm">Únete a {info?.espacio ?? "tu equipo"}</h2>
        {error && <Banner tono="error" icono="error">{error}</Banner>}
        {info && (
          <>
            <p className="tenue">Invitación para <b>{info.email}</b> como <b>{info.rol}</b>.</p>
            {!info.tiene_cuenta && (
              <Campo etiqueta="Tu nombre"><input type="text" required value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
            )}
            <Campo etiqueta={info.tiene_cuenta ? "Tu contraseña actual" : "Crea una contraseña"}>
              <input type="password" required minLength={8} value={clave} onChange={(e) => setClave(e.target.value)} />
            </Campo>
            <button className="btn primario" type="submit">Aceptar invitación</button>
          </>
        )}
      </form>
    </Marco>
  );
}
