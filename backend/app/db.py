"""Motor de base de datos y sesión. SQLite en desarrollo, Postgres en producción."""
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import ajustes


def ahora() -> datetime:
    """Hora UTC sin tzinfo: así se guarda todo en la base."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


def _crear_motor(url: str):
    if url.startswith("sqlite"):
        motor = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(motor, "connect")
        def _pragmas(con, _):
            cur = con.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

        return motor
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=20)


motor = _crear_motor(ajustes().database_url)
FabricaSesion = sessionmaker(bind=motor, expire_on_commit=False)


def obtener_db():
    """Dependencia de FastAPI."""
    db = FabricaSesion()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def sesion() -> Session:
    """Para tareas en segundo plano."""
    db = FabricaSesion()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def crear_tablas():
    from . import modelos  # noqa: F401  registra los modelos

    Base.metadata.create_all(motor)
