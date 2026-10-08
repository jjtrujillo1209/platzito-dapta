"""Canales: líneas de WhatsApp (Embedded Signup o manual), plantillas, troncales SIP y números."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .. import serial
from ..canales import retell, whatsapp
from ..db import ahora
from ..integraciones import credenciales
from ..modelos import Agente, Envio, LineaWhatsapp, NumeroTelefono, Plantilla, TroncalSip
from ..secuencias import enviados_24h, tope_whatsapp
from ..seguridad import Contexto, cifrar, descifrar, requiere
from .contactos import normalizar_telefono

r = APIRouter(prefix="/api", tags=["canales"])


def _linea(ctx: Contexto, linea_id: int) -> LineaWhatsapp:
    l = ctx.db.get(LineaWhatsapp, linea_id)
    if not l or l.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Línea no encontrada")
    return l


def _troncal_valida(ctx: Contexto, troncal_id: int | None) -> TroncalSip | None:
    if troncal_id is None:
        return None
    t = ctx.db.get(TroncalSip, troncal_id)
    if not t or t.espacio_id != ctx.espacio_id:
        raise HTTPException(422, "Troncal inválida")
    return t


def _agente_valido(ctx: Contexto, agente_id: int | None):
    if agente_id is None:
        return
    a = ctx.db.get(Agente, agente_id)
    if not a or a.espacio_id != ctx.espacio_id:
        raise HTTPException(422, "Agente inválido")


# ─────────────────────────────── WhatsApp ───────────────────────────────

@r.get("/whatsapp/config-signup")
def config_signup(ctx: Contexto = Depends(requiere("admin"))):
    """Datos públicos para lanzar Embedded Signup (FB.login) desde el front."""
    cred = credenciales(ctx.db, ctx.espacio_id, "meta")
    from ..config import ajustes

    return {"app_id": cred.get("app_id"), "config_id": cred.get("config_id"),
            "graph_version": ajustes().meta_graph_version,
            "webhook_url": f"{ajustes().url_publica}/webhooks/whatsapp",
            "verify_token": ajustes().meta_verify_token, "listo": bool(cred.get("app_id") and cred.get("config_id"))}


@r.get("/lineas")
def lineas(ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(LineaWhatsapp).where(LineaWhatsapp.espacio_id == ctx.espacio_id)).all()
    return [serial.linea(l, tope_whatsapp(ctx.db, l), enviados_24h(ctx.db, l.id)) for l in filas]


async def _alta_linea(ctx: Contexto, phone_number_id: str, waba_id: str, token: str, coexistencia: bool,
                      agente_id: int | None) -> LineaWhatsapp:
    try:
        info = await whatsapp.info_numero(phone_number_id, token)
    except whatsapp.ErrorWhatsapp as e:
        raise HTTPException(422, f"Meta rechazó los datos: {e}")
    l = ctx.db.scalar(select(LineaWhatsapp).where(LineaWhatsapp.phone_number_id == phone_number_id))
    if l and l.espacio_id != ctx.espacio_id:
        raise HTTPException(409, "Esa línea ya está conectada en otro espacio")
    if not l:
        l = LineaWhatsapp(espacio_id=ctx.espacio_id, phone_number_id=phone_number_id)
        ctx.db.add(l)
    l.waba_id = waba_id
    l.token_cifrado = cifrar(token)
    l.numero_visible = info.get("display_phone_number", "")
    l.nombre_verificado = info.get("verified_name", "")
    l.calidad = info.get("quality_rating", "UNKNOWN")
    l.tier = info.get("messaging_limit_tier") or l.tier
    l.coexistencia = coexistencia
    l.estado = "conectada"
    l.calidad_revisada_en = ahora()
    if agente_id is not None:
        l.agente_id = agente_id
    ctx.db.commit()
    return l


class SignupWhatsapp(BaseModel):
    code: str
    waba_id: str
    phone_number_id: str
    pin: str = Field("", pattern=r"^(\d{6})?$")
    coexistencia: bool = False
    agente_id: int | None = None


@r.post("/lineas/embedded-signup")
async def embedded_signup(datos: SignupWhatsapp, ctx: Contexto = Depends(requiere("admin"))):
    """code → token del negocio, suscribe la app a la WABA y registra el número (salvo coexistencia)."""
    _agente_valido(ctx, datos.agente_id)
    cred = credenciales(ctx.db, ctx.espacio_id, "meta")
    if not cred.get("app_id") or not cred.get("app_secret"):
        raise HTTPException(422, "Configura la app de Meta en Ajustes → Integraciones")
    try:
        token = await whatsapp.canjear_codigo(cred["app_id"], cred["app_secret"], datos.code)
        await whatsapp.suscribir_app(datos.waba_id, token)
        if not datos.coexistencia:
            await whatsapp.registrar_numero(datos.phone_number_id, token, datos.pin or "000000")
    except whatsapp.ErrorWhatsapp as e:
        raise HTTPException(502, str(e))
    l = await _alta_linea(ctx, datos.phone_number_id, datos.waba_id, token, datos.coexistencia, datos.agente_id)
    await _sincronizar_plantillas(ctx, l)
    return serial.linea(l)


class LineaManual(BaseModel):
    phone_number_id: str
    waba_id: str
    token: str = Field(min_length=20)
    agente_id: int | None = None


@r.post("/lineas")
async def linea_manual(datos: LineaManual, ctx: Contexto = Depends(requiere("admin"))):
    """Alta con token de System User (cuando el negocio es propio y no hace falta Embedded Signup)."""
    _agente_valido(ctx, datos.agente_id)
    l = await _alta_linea(ctx, datos.phone_number_id, datos.waba_id, datos.token, False, datos.agente_id)
    try:
        await whatsapp.suscribir_app(datos.waba_id, datos.token)
    except whatsapp.ErrorWhatsapp:
        pass  # puede estar suscrita ya o el token no tener permiso; los webhooks se configuran en la app
    await _sincronizar_plantillas(ctx, l)
    return serial.linea(l)


class CambiosLinea(BaseModel):
    agente_id: int | None = None
    tope_diario_manual: int | None = None
    marketing_pausado: bool | None = None
    quitar_agente: bool = False


@r.patch("/lineas/{linea_id}")
def editar_linea(linea_id: int, datos: CambiosLinea, ctx: Contexto = Depends(requiere("admin"))):
    l = _linea(ctx, linea_id)
    if datos.quitar_agente:
        l.agente_id = None
    elif datos.agente_id is not None:
        _agente_valido(ctx, datos.agente_id)
        l.agente_id = datos.agente_id
    if datos.tope_diario_manual is not None:
        l.tope_diario_manual = datos.tope_diario_manual or None
    if datos.marketing_pausado is not None:
        l.marketing_pausado = datos.marketing_pausado
    ctx.db.commit()
    return serial.linea(l, tope_whatsapp(ctx.db, l), enviados_24h(ctx.db, l.id))


@r.delete("/lineas/{linea_id}")
def borrar_linea(linea_id: int, ctx: Contexto = Depends(requiere("admin"))):
    l = _linea(ctx, linea_id)
    l.estado = "desconectada"
    l.token_cifrado = ""
    ctx.db.commit()
    return {"ok": True}


async def _sincronizar_plantillas(ctx: Contexto, l: LineaWhatsapp) -> int:
    try:
        remotas = await whatsapp.listar_plantillas(l)
    except whatsapp.ErrorWhatsapp:
        return 0
    for t in remotas:
        p = ctx.db.scalar(select(Plantilla).where(Plantilla.linea_id == l.id, Plantilla.nombre == t["name"],
                                                  Plantilla.idioma == t["language"]))
        if not p:
            p = Plantilla(espacio_id=ctx.espacio_id, linea_id=l.id, nombre=t["name"], idioma=t["language"])
            ctx.db.add(p)
        p.estado = t.get("status", p.estado)
        p.categoria = t.get("category", p.categoria)
        p.componentes = t.get("components", [])
        p.meta_id = t.get("id")
        p.motivo_rechazo = t.get("rejected_reason", "") or ""
        cuerpo = next((c.get("text", "") for c in p.componentes if c.get("type") == "BODY"), "")
        p.cuerpo = cuerpo
        p.n_variables = whatsapp.variables_de_cuerpo(cuerpo)
    ctx.db.commit()
    return len(remotas)


@r.post("/lineas/{linea_id}/sincronizar")
async def sincronizar(linea_id: int, ctx: Contexto = Depends(requiere("editor"))):
    l = _linea(ctx, linea_id)
    try:
        info = await whatsapp.estado_linea(l)
    except whatsapp.ErrorWhatsapp as e:
        raise HTTPException(502, str(e))
    l.calidad = info.get("quality_rating", l.calidad)
    l.tier = info.get("messaging_limit_tier") or l.tier
    l.numero_visible = info.get("display_phone_number", l.numero_visible)
    l.calidad_revisada_en = ahora()
    if l.calidad == "RED":
        l.marketing_pausado = True
    ctx.db.commit()
    n = await _sincronizar_plantillas(ctx, l)
    return {**serial.linea(l, tope_whatsapp(ctx.db, l), enviados_24h(ctx.db, l.id)), "plantillas": n}


@r.get("/lineas/{linea_id}/salud")
def salud(linea_id: int, ctx: Contexto = Depends(requiere("lector"))):
    l = _linea(ctx, linea_id)
    dia = func.date(Envio.creado)
    serie = ctx.db.execute(select(dia, func.count(Envio.id)).where(
        Envio.linea_id == l.id, Envio.creado >= ahora() - timedelta(days=14)).group_by(dia).order_by(dia)).all()
    return {"linea": serial.linea(l, tope_whatsapp(ctx.db, l), enviados_24h(ctx.db, l.id)),
            "envios_por_dia": [{"dia": str(d), "envios": n} for d, n in serie],
            "dias_calentamiento": (ahora() - l.calentamiento_desde).days}


# ─────────────────────────────── Plantillas ───────────────────────────────

@r.get("/plantillas")
def plantillas(linea_id: int | None = None, ctx: Contexto = Depends(requiere("lector"))):
    q = select(Plantilla).where(Plantilla.espacio_id == ctx.espacio_id)
    if linea_id:
        q = q.where(Plantilla.linea_id == linea_id)
    return [serial.plantilla(p) for p in ctx.db.scalars(q.order_by(Plantilla.carpeta, Plantilla.nombre))]


class NuevaPlantilla(BaseModel):
    linea_id: int
    nombre: str = Field(pattern=r"^[a-z0-9_]{1,512}$")
    idioma: str = "es"
    categoria: str = Field("MARKETING", pattern="^(MARKETING|UTILITY|AUTHENTICATION)$")
    cuerpo: str = Field(min_length=1, max_length=1024)
    ejemplos: list[str] = []
    encabezado: str = ""
    pie: str = ""
    botones: list[dict] = []
    carpeta: str = ""


@r.post("/plantillas")
async def crear_plantilla(datos: NuevaPlantilla, ctx: Contexto = Depends(requiere("editor"))):
    l = _linea(ctx, datos.linea_id)
    n = whatsapp.variables_de_cuerpo(datos.cuerpo)
    if len(datos.ejemplos) < n:
        raise HTTPException(422, f"La plantilla usa {n} variables: da un ejemplo para cada una")
    try:
        resp = await whatsapp.crear_plantilla(l, datos.nombre, datos.idioma, datos.categoria, datos.cuerpo,
                                              datos.ejemplos[:n], datos.encabezado, datos.pie, datos.botones)
    except whatsapp.ErrorWhatsapp as e:
        raise HTTPException(502, str(e))
    p = Plantilla(espacio_id=ctx.espacio_id, linea_id=l.id, nombre=datos.nombre, idioma=datos.idioma,
                  categoria=resp.get("category", datos.categoria), estado=resp.get("status", "PENDING"),
                  cuerpo=datos.cuerpo, n_variables=n, carpeta=datos.carpeta, meta_id=resp.get("id"),
                  componentes=[{"type": "BODY", "text": datos.cuerpo}])
    ctx.db.add(p)
    ctx.db.commit()
    return serial.plantilla(p)


@r.patch("/plantillas/{plantilla_id}")
def mover_plantilla(plantilla_id: int, datos: dict, ctx: Contexto = Depends(requiere("editor"))):
    p = ctx.db.get(Plantilla, plantilla_id)
    if not p or p.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrada")
    p.carpeta = (datos.get("carpeta") or "")[:80]
    ctx.db.commit()
    return serial.plantilla(p)


# ─────────────────────────────── Troncales SIP y números ───────────────────────────────

class DatosTroncal(BaseModel):
    nombre: str = Field(min_length=1, max_length=120)
    termination_uri: str = Field(min_length=3, max_length=300)
    usuario: str = ""
    clave: str = ""
    canales: int = Field(10, ge=1, le=1000)


@r.get("/troncales")
def troncales(ctx: Contexto = Depends(requiere("lector"))):
    return [serial.troncal(t) for t in ctx.db.scalars(select(TroncalSip)
                                                      .where(TroncalSip.espacio_id == ctx.espacio_id))]


@r.post("/troncales")
def crear_troncal(datos: DatosTroncal, ctx: Contexto = Depends(requiere("admin"))):
    t = TroncalSip(espacio_id=ctx.espacio_id, nombre=datos.nombre, termination_uri=datos.termination_uri,
                   usuario=datos.usuario, clave_cifrada=cifrar(datos.clave) if datos.clave else "",
                   canales=datos.canales)
    ctx.db.add(t)
    ctx.db.commit()
    return serial.troncal(t)


class CambiosTroncal(BaseModel):
    nombre: str | None = Field(None, min_length=1, max_length=120)
    termination_uri: str | None = Field(None, min_length=3, max_length=300)
    usuario: str | None = None
    clave: str | None = None  # vacío o ausente = conservar la actual
    canales: int | None = Field(None, ge=1, le=1000)


@r.patch("/troncales/{troncal_id}")
def editar_troncal(troncal_id: int, datos: CambiosTroncal, ctx: Contexto = Depends(requiere("admin"))):
    t = ctx.db.get(TroncalSip, troncal_id)
    if not t or t.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrada")
    for campo in ("nombre", "termination_uri", "usuario", "canales"):
        valor = getattr(datos, campo)
        if valor is not None:
            setattr(t, campo, valor)
    if datos.clave:
        t.clave_cifrada = cifrar(datos.clave)
    ctx.db.commit()
    return serial.troncal(t)


@r.delete("/troncales/{troncal_id}")
def borrar_troncal(troncal_id: int, ctx: Contexto = Depends(requiere("admin"))):
    t = ctx.db.get(TroncalSip, troncal_id)
    if t and t.espacio_id == ctx.espacio_id:
        ctx.db.delete(t)
        ctx.db.commit()
    return {"ok": True}


def _usos(ctx: Contexto) -> dict:
    return dict(ctx.db.execute(select(Envio.numero_id, func.count(Envio.id)).where(
        Envio.espacio_id == ctx.espacio_id, Envio.numero_id.is_not(None),
        Envio.creado >= ahora() - timedelta(hours=24)).group_by(Envio.numero_id)).all())


@r.get("/numeros")
def numeros(ctx: Contexto = Depends(requiere("lector"))):
    usos = _usos(ctx)
    return [serial.numero(n, usos.get(n.id, 0)) for n in ctx.db.scalars(
        select(NumeroTelefono).where(NumeroTelefono.espacio_id == ctx.espacio_id))]


class DatosNumero(BaseModel):
    numero: str
    etiqueta: str = ""
    proveedor: str = Field("sip", pattern="^(sip|retell|twilio)$")
    troncal_id: int | None = None
    agente_entrante_id: int | None = None
    tope_diario: int = Field(150, ge=1, le=5000)
    activo: bool = True


@r.post("/numeros")
async def crear_numero(datos: DatosNumero, ctx: Contexto = Depends(requiere("admin"))):
    tel = normalizar_telefono(datos.numero)
    if not tel:
        raise HTTPException(422, "Número inválido (usa formato internacional, p. ej. +57…)")
    _agente_valido(ctx, datos.agente_entrante_id)
    _troncal_valida(ctx, datos.troncal_id)
    n = NumeroTelefono(espacio_id=ctx.espacio_id, numero=tel, etiqueta=datos.etiqueta, proveedor=datos.proveedor,
                       troncal_id=datos.troncal_id, agente_entrante_id=datos.agente_entrante_id,
                       tope_diario=datos.tope_diario, activo=datos.activo,
                       importado_retell=datos.proveedor == "retell")
    ctx.db.add(n)
    ctx.db.commit()
    return serial.numero(n, 0)


@r.patch("/numeros/{numero_id}")
async def editar_numero(numero_id: int, datos: dict, ctx: Contexto = Depends(requiere("admin"))):
    n = ctx.db.get(NumeroTelefono, numero_id)
    if not n or n.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrado")
    for campo in ("etiqueta", "tope_diario", "activo"):
        if campo in datos:
            setattr(n, campo, datos[campo])
    if "troncal_id" in datos:
        _troncal_valida(ctx, datos["troncal_id"])
        n.troncal_id = datos["troncal_id"]
    if "agente_entrante_id" in datos:
        _agente_valido(ctx, datos["agente_entrante_id"])
        n.agente_entrante_id = datos["agente_entrante_id"]
        if n.importado_retell:
            a = ctx.db.get(Agente, n.agente_entrante_id) if n.agente_entrante_id else None
            try:
                await retell.actualizar_numero(credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key", ""),
                                               n.numero, a.retell_agent_id if a else None, None)
            except retell.ErrorRetell as e:
                raise HTTPException(502, str(e))
    ctx.db.commit()
    return serial.numero(n)


@r.post("/numeros/{numero_id}/importar-retell")
async def importar_a_retell(numero_id: int, ctx: Contexto = Depends(requiere("admin"))):
    """Importa el número del SIP trunk a Retell para poder llamar y recibir con el agente."""
    n = ctx.db.get(NumeroTelefono, numero_id)
    if not n or n.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrado")
    t = ctx.db.get(TroncalSip, n.troncal_id) if n.troncal_id else None
    if not t or t.espacio_id != ctx.espacio_id:
        raise HTTPException(422, "Asocia una troncal SIP al número")
    entrante = ctx.db.get(Agente, n.agente_entrante_id) if n.agente_entrante_id else None
    try:
        await retell.importar_numero(credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key", ""), n.numero,
                                     t.termination_uri, t.usuario, descifrar(t.clave_cifrada),
                                     entrante.retell_agent_id if entrante else None, None, n.etiqueta)
    except retell.ErrorRetell as e:
        raise HTTPException(502, str(e))
    n.importado_retell = True
    ctx.db.commit()
    return serial.numero(n)


@r.delete("/numeros/{numero_id}")
def borrar_numero(numero_id: int, ctx: Contexto = Depends(requiere("admin"))):
    n = ctx.db.get(NumeroTelefono, numero_id)
    if n and n.espacio_id == ctx.espacio_id:
        ctx.db.delete(n)
        ctx.db.commit()
    return {"ok": True}
