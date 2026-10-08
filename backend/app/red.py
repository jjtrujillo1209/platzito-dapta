"""Utilidades de red: protección SSRF para URLs que escriben los usuarios."""
import ipaddress
import socket
from urllib.parse import urlparse

from .config import ajustes


class UrlNoPermitida(ValueError):
    pass


def validar_url_externa(url: str) -> str:
    """Rechaza esquemas raros e IPs privadas/locales (en producción) antes de pedir una URL ajena."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise UrlNoPermitida(f"URL inválida: {url}")
    if not ajustes().es_produccion:
        return url
    try:
        direcciones = {info[4][0] for info in socket.getaddrinfo(p.hostname, None)}
    except socket.gaierror as e:
        raise UrlNoPermitida(f"No se pudo resolver {p.hostname}") from e
    for d in direcciones:
        ip = ipaddress.ip_address(d)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise UrlNoPermitida(f"Destino no permitido: {p.hostname}")
    return url
