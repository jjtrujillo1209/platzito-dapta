"""Tareas en segundo plano dentro del proceso (se guarda la referencia para que no las recolecte el GC)."""
import asyncio
import logging

log = logging.getLogger("platzito.fondo")
_tareas: set[asyncio.Task] = set()


def _fin(t: asyncio.Task):
    _tareas.discard(t)
    if not t.cancelled() and t.exception():
        log.error("Tarea en segundo plano falló", exc_info=t.exception())


def lanzar(coro) -> asyncio.Task:
    t = asyncio.get_running_loop().create_task(coro)
    _tareas.add(t)
    t.add_done_callback(_fin)
    return t
