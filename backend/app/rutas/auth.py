"""Registro, inicio de sesión, invitaciones y miembros del espacio."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import obtener_db
from ..modelos import ROLES, Espacio, Invitacion, Miembro, Usuario
from ..seguridad import (NIVEL, Contexto, crear_token, hash_clave, requiere, token_aleatorio, usuario_actual,
                         verificar_clave)

r = APIRouter(prefix="/api", tags=["auth"])


class Registro(BaseModel):
    nombre: str = Field(min_length=2, max_length=120)
    email: EmailStr
    clave: str = Field(min_length=8, max_length=200)
    espacio: str = Field("Mi empresa", min_length=2, max_length=120)
    zona_horaria: str = "America/Bogota"


class Login(BaseModel):
    email: EmailStr
    clave: str


def _sesion(db: Session, u: Usuario) -> dict:
    miembros = db.scalars(select(Miembro).where(Miembro.usuario_id == u.id)).all()
    espacios = [{"id": m.espacio_id, "nombre": db.get(Espacio, m.espacio_id).nombre, "rol": m.rol} for m in miembros]
    return {"token": crear_token(u.id), "usuario": {"id": u.id, "nombre": u.nombre, "email": u.email},
            "espacios": espacios}


@r.post("/auth/registro")
def registro(datos: Registro, db: Session = Depends(obtener_db)):
    if db.scalar(select(Usuario).where(Usuario.email == datos.email.lower())):
        raise HTTPException(409, "Ese correo ya tiene cuenta")
    u = Usuario(email=datos.email.lower(), nombre=datos.nombre, clave_hash=hash_clave(datos.clave))
    e = Espacio(nombre=datos.espacio, zona_horaria=datos.zona_horaria)
    db.add_all([u, e])
    db.flush()
    db.add(Miembro(espacio_id=e.id, usuario_id=u.id, rol="propietario"))
    db.commit()
    return _sesion(db, u)


@r.post("/auth/login")
def login(datos: Login, db: Session = Depends(obtener_db)):
    u = db.scalar(select(Usuario).where(Usuario.email == datos.email.lower()))
    if not u or not verificar_clave(datos.clave, u.clave_hash) or not u.activo:
        raise HTTPException(401, "Correo o contraseña incorrectos")
    return _sesion(db, u)


@r.get("/auth/yo")
def yo(u: Usuario = Depends(usuario_actual), db: Session = Depends(obtener_db)):
    return _sesion(db, u)


@r.post("/auth/espacios")
def nuevo_espacio(datos: dict, u: Usuario = Depends(usuario_actual), db: Session = Depends(obtener_db)):
    nombre = (datos.get("nombre") or "").strip()
    if len(nombre) < 2:
        raise HTTPException(422, "Nombre inválido")
    e = Espacio(nombre=nombre[:120], zona_horaria=datos.get("zona_horaria") or "America/Bogota")
    db.add(e)
    db.flush()
    db.add(Miembro(espacio_id=e.id, usuario_id=u.id, rol="propietario"))
    db.commit()
    return _sesion(db, u)


# ─────────────────────────────── Invitaciones ───────────────────────────────

class NuevaInvitacion(BaseModel):
    email: EmailStr
    rol: str = "editor"


@r.post("/invitaciones")
def invitar(datos: NuevaInvitacion, ctx: Contexto = Depends(requiere("admin"))):
    if datos.rol not in ROLES or NIVEL[datos.rol] > NIVEL[ctx.rol]:
        raise HTTPException(422, "Rol inválido")
    inv = Invitacion(espacio_id=ctx.espacio_id, email=datos.email.lower(), rol=datos.rol, token=token_aleatorio())
    ctx.db.add(inv)
    ctx.db.commit()
    return {"id": inv.id, "token": inv.token, "email": inv.email, "rol": inv.rol}


@r.get("/invitaciones/{token}")
def ver_invitacion(token: str, db: Session = Depends(obtener_db)):
    inv = db.scalar(select(Invitacion).where(Invitacion.token == token, Invitacion.usada.is_(False)))
    if not inv:
        raise HTTPException(404, "Invitación inválida o usada")
    existe = db.scalar(select(Usuario.id).where(Usuario.email == inv.email)) is not None
    return {"email": inv.email, "rol": inv.rol, "espacio": db.get(Espacio, inv.espacio_id).nombre,
            "tiene_cuenta": existe}


class Aceptar(BaseModel):
    nombre: str = ""
    clave: str = Field(min_length=8)


@r.post("/invitaciones/{token}/aceptar")
def aceptar(token: str, datos: Aceptar, db: Session = Depends(obtener_db)):
    inv = db.scalar(select(Invitacion).where(Invitacion.token == token, Invitacion.usada.is_(False)))
    if not inv:
        raise HTTPException(404, "Invitación inválida o usada")
    u = db.scalar(select(Usuario).where(Usuario.email == inv.email))
    if u:
        if not verificar_clave(datos.clave, u.clave_hash):
            raise HTTPException(401, "Contraseña incorrecta")
    else:
        u = Usuario(email=inv.email, nombre=datos.nombre or inv.email.split("@")[0], clave_hash=hash_clave(datos.clave))
        db.add(u)
        db.flush()
    if not db.scalar(select(Miembro).where(Miembro.espacio_id == inv.espacio_id, Miembro.usuario_id == u.id)):
        db.add(Miembro(espacio_id=inv.espacio_id, usuario_id=u.id, rol=inv.rol))
    inv.usada = True
    db.commit()
    return _sesion(db, u)


# ─────────────────────────────── Miembros ───────────────────────────────

@r.get("/miembros")
def miembros(ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(Miembro).where(Miembro.espacio_id == ctx.espacio_id)).all()
    pendientes = ctx.db.scalars(select(Invitacion).where(Invitacion.espacio_id == ctx.espacio_id,
                                                         Invitacion.usada.is_(False))).all()
    return {"miembros": [{"id": m.id, "usuario_id": m.usuario_id, "nombre": m.usuario.nombre,
                          "email": m.usuario.email, "rol": m.rol} for m in filas],
            "invitaciones": [{"id": i.id, "email": i.email, "rol": i.rol,
                              **({"token": i.token} if NIVEL[ctx.rol] >= NIVEL["admin"] else {})}
                             for i in pendientes]}


@r.patch("/miembros/{miembro_id}")
def cambiar_rol(miembro_id: int, datos: dict, ctx: Contexto = Depends(requiere("admin"))):
    m = ctx.db.get(Miembro, miembro_id)
    rol = datos.get("rol")
    if not m or m.espacio_id != ctx.espacio_id or rol not in ROLES:
        raise HTTPException(404, "No encontrado")
    if NIVEL[rol] > NIVEL[ctx.rol] or (m.rol == "propietario" and ctx.rol != "propietario"):
        raise HTTPException(403, "No puedes asignar ese rol")
    m.rol = rol
    ctx.db.commit()
    return {"ok": True}


@r.delete("/miembros/{miembro_id}")
def quitar(miembro_id: int, ctx: Contexto = Depends(requiere("admin"))):
    m = ctx.db.get(Miembro, miembro_id)
    if not m or m.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrado")
    if m.rol == "propietario":
        raise HTTPException(403, "No se puede quitar al propietario")
    ctx.db.delete(m)
    ctx.db.commit()
    return {"ok": True}


@r.delete("/invitaciones/{inv_id}")
def borrar_invitacion(inv_id: int, ctx: Contexto = Depends(requiere("admin"))):
    inv = ctx.db.get(Invitacion, inv_id)
    if inv and inv.espacio_id == ctx.espacio_id:
        ctx.db.delete(inv)
        ctx.db.commit()
    return {"ok": True}
