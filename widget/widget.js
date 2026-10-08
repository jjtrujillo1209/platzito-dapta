/*
 * Widget de Platzito: chat (y voz opcional) embebible en cualquier sitio.
 *
 *   <script src="https://TU-HOST/widget.js" data-agente="pk_..." async></script>
 *
 * Opcionales: data-posicion="izquierda" · data-abierto="true"
 * Sin dependencias; los estilos viven en un Shadow DOM para no chocar con la página.
 */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector('script[data-agente][src*="widget.js"]');
  if (!script) return;
  var CLAVE = script.getAttribute("data-agente");
  if (!CLAVE || window.__platzitoWidget && window.__platzitoWidget[CLAVE]) return;
  window.__platzitoWidget = window.__platzitoWidget || {};
  window.__platzitoWidget[CLAVE] = true;
  var BASE = new URL(script.src, location.href).origin;
  var API = BASE + "/widget/" + encodeURIComponent(CLAVE);
  var IZQ = script.getAttribute("data-posicion") === "izquierda";
  var LLAVE = "platzito.widget." + CLAVE;

  function leer() { try { return JSON.parse(localStorage.getItem(LLAVE) || "null"); } catch (e) { return null; } }
  function guardar(v) { try { localStorage.setItem(LLAVE, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
  function borrar() { try { localStorage.removeItem(LLAVE); } catch (e) { /* nada */ } }

  var estado = { config: null, token: null, ultimoId: 0, ids: {}, abierto: false, enviando: false, humano: false, llamada: null, sondeo: null };

  function pedir(metodo, ruta, cuerpo) {
    var cab = { "content-type": "application/json" };
    if (estado.token) cab["x-widget-token"] = estado.token;
    return fetch(API + ruta, { method: metodo, headers: cab, body: cuerpo ? JSON.stringify(cuerpo) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(typeof d.detail === "string" ? d.detail : "Error " + r.status); e.estado = r.status; throw e; }
          return d;
        });
      });
  }

  // ───────── Interfaz ─────────
  var anfitrion = document.createElement("div");
  anfitrion.setAttribute("data-platzito", "");
  var raiz = anfitrion.attachShadow ? anfitrion.attachShadow({ mode: "open" }) : anfitrion;
  var css = [
    ":host{all:initial}",
    "[hidden]{display:none!important}",
    "*{box-sizing:border-box;font-family:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".burbuja{position:fixed;bottom:20px;" + (IZQ ? "left" : "right") + ":20px;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;background:var(--c);color:#06140d;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:2147483000;transition:transform .15s}",
    ".burbuja:hover{transform:scale(1.06)}.burbuja:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid #7fd0f9;outline-offset:2px}",
    ".burbuja svg{width:28px;height:28px}",
    ".panel{position:fixed;bottom:92px;" + (IZQ ? "left" : "right") + ":20px;width:380px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 120px);background:#121413;color:#e2e3e1;border:1px solid #3f4949;border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.4);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}",
    ".panel.abierto{display:flex}",
    "@media (max-width:480px){.panel{bottom:0;left:0;right:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.burbuja.oculta{display:none}}",
    ".cab{display:flex;align-items:center;gap:10px;padding:14px 16px;background:#1c1f1e;border-bottom:1px solid #3f4949}",
    ".cab .t{flex:1;min-width:0}.cab b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cab small{color:#bec8c9;font-size:12px}",
    ".ico{background:none;border:none;color:#e2e3e1;cursor:pointer;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center}.ico:hover{background:rgba(255,255,255,.08)}.ico svg{width:20px;height:20px}",
    ".llamar{background:var(--c);color:#06140d;border:none;border-radius:999px;height:32px;padding:0 12px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px}.llamar.colgar{background:#ffb4ab;color:#690005}.llamar svg{width:16px;height:16px}",
    ".msjs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}",
    ".m{max-width:82%;padding:9px 13px;border-radius:16px;font-size:14px;line-height:20px;white-space:pre-wrap;word-break:break-word}",
    ".m.ia{align-self:flex-start;background:#282b29;border-bottom-left-radius:4px}.m.humano{align-self:flex-start;background:#2c3a33;border-bottom-left-radius:4px}",
    ".m.yo{align-self:flex-end;background:var(--c);color:#06140d;border-bottom-right-radius:4px}",
    ".m a{color:inherit;text-decoration:underline}.fuentes{margin-top:6px;font-size:12px;opacity:.8}.fuentes a{display:block}",
    ".aviso{align-self:center;font-size:12px;color:#bec8c9;text-align:center;padding:4px 8px}",
    ".escribiendo{align-self:flex-start;background:#282b29;border-radius:16px;padding:12px 14px;display:none;gap:4px}.escribiendo.si{display:flex}",
    ".escribiendo i{width:6px;height:6px;border-radius:50%;background:#bec8c9;animation:p 1.2s infinite}.escribiendo i:nth-child(2){animation-delay:.2s}.escribiendo i:nth-child(3){animation-delay:.4s}",
    "@keyframes p{0%,60%,100%{opacity:.3}30%{opacity:1}}",
    "form.pie{display:flex;gap:8px;padding:12px;border-top:1px solid #3f4949;background:#1c1f1e}",
    "textarea{flex:1;resize:none;background:#121413;color:#e2e3e1;border:1px solid #3f4949;border-radius:14px;padding:10px 12px;font-size:14px;line-height:20px;max-height:120px;min-height:42px}",
    ".enviar{background:var(--c);color:#06140d;border:none;border-radius:50%;width:42px;height:42px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.enviar:disabled{opacity:.4;cursor:default}.enviar svg{width:20px;height:20px}",
    ".pre{padding:20px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}.pre p{margin:0;color:#bec8c9;font-size:14px}",
    ".pre label{font-size:12px;font-weight:600;color:#bec8c9;display:flex;flex-direction:column;gap:4px}",
    ".pre input{background:#121413;color:#e2e3e1;border:1px solid #3f4949;border-radius:10px;padding:10px 12px;font-size:14px}",
    ".pre button{background:var(--c);color:#06140d;border:none;border-radius:999px;height:42px;font-weight:700;font-size:14px;cursor:pointer}",
    ".marca{font-size:11px;color:#899393;text-align:center;padding:0 0 8px;background:#1c1f1e}"
  ].join("\n");

  var SVG = {
    chat: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>',
    cerrar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    enviar: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z"/></svg>',
    tel: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>'
  };

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (html) e.innerHTML = html;
    return e;
  }

  var estilo = el("style"); estilo.textContent = css; raiz.appendChild(estilo);
  var burbuja = el("button", { class: "burbuja", "aria-label": "Abrir chat", "aria-expanded": "false" }, SVG.chat);
  var panel = el("div", { class: "panel", role: "dialog", "aria-label": "Chat" });
  var cab = el("div", { class: "cab" });
  var titulo = el("div", { class: "t" }, "<b></b><small>Normalmente responde en segundos</small>");
  var btnLlamar = el("button", { class: "llamar", type: "button", hidden: "" }, SVG.tel + "<span>Llamar</span>");
  var btnCerrar = el("button", { class: "ico", type: "button", "aria-label": "Cerrar chat" }, SVG.cerrar);
  cab.appendChild(titulo); cab.appendChild(btnLlamar); cab.appendChild(btnCerrar);
  var msjs = el("div", { class: "msjs", role: "log", "aria-live": "polite" });
  var escribiendo = el("div", { class: "escribiendo", "aria-label": "Escribiendo" }, "<i></i><i></i><i></i>");
  var pie = el("form", { class: "pie" });
  var entrada = el("textarea", { rows: "1", placeholder: "Escribe tu mensaje…", "aria-label": "Mensaje", maxlength: "2000" });
  var btnEnviar = el("button", { class: "enviar", type: "submit", "aria-label": "Enviar" }, SVG.enviar);
  pie.appendChild(entrada); pie.appendChild(btnEnviar);
  var marca = el("div", { class: "marca" }, "Con tecnología de Platzito");
  panel.appendChild(cab); panel.appendChild(msjs); panel.appendChild(pie); panel.appendChild(marca);
  raiz.appendChild(burbuja); raiz.appendChild(panel);

  function aviso(texto) {
    var a = el("div", { class: "aviso" }); a.textContent = texto; msjs.appendChild(a); bajar();
  }
  function bajar() { msjs.scrollTop = msjs.scrollHeight; }

  /** Texto plano con enlaces clicables (sin innerHTML con datos del servidor). */
  function pintarTexto(nodo, texto) {
    var partes = String(texto || "").split(/(https?:\/\/[^\s)]+)/g);
    partes.forEach(function (p) {
      if (/^https?:\/\//.test(p)) {
        var a = document.createElement("a"); a.href = p; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = p; nodo.appendChild(a);
      } else nodo.appendChild(document.createTextNode(p));
    });
  }

  function pintar(m, propio) {
    if (m.id && estado.ids[m.id]) return;
    if (m.id) { estado.ids[m.id] = true; estado.ultimoId = Math.max(estado.ultimoId, m.id); }
    var clase = propio ? "yo" : m.autor === "humano" ? "humano" : "ia";
    var b = el("div", { class: "m " + clase });
    pintarTexto(b, m.contenido);
    var fuentes = (m.fuentes || []).filter(function (f) { return f && f.url; });
    if (fuentes.length) {
      var f = el("div", { class: "fuentes" }); f.appendChild(document.createTextNode("Fuentes:"));
      var vistos = {};
      fuentes.forEach(function (x) {
        if (vistos[x.url]) return; vistos[x.url] = 1;
        var a = document.createElement("a"); a.href = x.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = x.titulo || x.url; f.appendChild(a);
      });
      b.appendChild(f);
    }
    msjs.insertBefore(b, escribiendo.parentNode === msjs ? escribiendo : null);
    bajar();
  }

  function marcarHumano(h) {
    if (h && !estado.humano) aviso("Una persona del equipo continuará la conversación.");
    estado.humano = !!h;
  }

  // ───────── Sesión ─────────
  function iniciarSesion(datos) {
    return pedir("POST", "/sesion", Object.assign({ pagina: location.href.slice(0, 500) }, datos || {})).then(function (s) {
      estado.token = s.token;
      guardar({ token: s.token });
      msjs.innerHTML = ""; estado.ids = {}; estado.ultimoId = 0; msjs.appendChild(escribiendo);
      (s.mensajes || []).forEach(function (m) { pintar(m, m.autor === "contacto"); });
    });
  }

  function retomar() {
    var g = leer();
    if (!g || !g.token) return Promise.resolve(false);
    estado.token = g.token;
    msjs.appendChild(escribiendo);
    return pedir("GET", "/mensajes?desde_id=0").then(function (d) {
      (d.mensajes || []).forEach(function (m) { pintar(m, false); });
      marcarHumano(d.humano);
      return true;
    }).catch(function () { estado.token = null; borrar(); return false; });
  }

  function sondear() {
    if (!estado.token || !estado.abierto || document.hidden) return;
    pedir("GET", "/mensajes?desde_id=" + estado.ultimoId).then(function (d) {
      (d.mensajes || []).forEach(function (m) { pintar(m, false); });
      marcarHumano(d.humano);
    }).catch(function () { /* reintenta en el próximo ciclo */ });
  }

  function enviar(texto) {
    texto = texto.trim();
    if (!texto || estado.enviando) return;
    estado.enviando = true; btnEnviar.disabled = true;
    pintar({ contenido: texto }, true);
    entrada.value = ""; ajustar();
    escribiendo.classList.add("si"); msjs.appendChild(escribiendo); bajar();
    var listo = estado.token ? Promise.resolve() : iniciarSesion();
    listo.then(function () { return pedir("POST", "/mensajes", { texto: texto }); })
      .then(function (d) { (d.mensajes || []).forEach(function (m) { pintar(m, false); }); marcarHumano(d.humano); })
      .catch(function (e) {
        if (e.estado === 401) { borrar(); estado.token = null; aviso("La sesión expiró. Vuelve a enviar tu mensaje."); }
        else aviso(e.message || "No se pudo enviar el mensaje.");
      })
      .then(function () { estado.enviando = false; btnEnviar.disabled = false; escribiendo.classList.remove("si"); entrada.focus(); });
  }

  function ajustar() { entrada.style.height = "auto"; entrada.style.height = Math.min(entrada.scrollHeight, 120) + "px"; }

  function formularioPrevio() {
    var f = el("form", { class: "pre" });
    f.innerHTML = '<p>Antes de empezar, cuéntanos quién eres:</p>' +
      '<label>Nombre<input name="nombre" required maxlength="200" autocomplete="name"></label>' +
      '<label>Correo<input name="email" type="email" maxlength="200" autocomplete="email"></label>' +
      '<label>WhatsApp / teléfono<input name="telefono" type="tel" maxlength="40" autocomplete="tel"></label>' +
      '<button type="submit">Empezar</button>';
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var d = { nombre: f.nombre.value.trim(), email: f.email.value.trim(), telefono: f.telefono.value.trim() };
      f.querySelector("button").disabled = true;
      iniciarSesion(d).then(function () { estado.formulario = false; panel.replaceChild(msjs, f); pie.style.display = ""; entrada.focus(); })
        .catch(function (e) { f.querySelector("button").disabled = false; alert(e.message); });
    });
    estado.formulario = true;
    panel.replaceChild(f, msjs); pie.style.display = "none";
  }

  // ───────── Voz (Retell web call) ─────────
  var cliente = null;
  function cargarRetell() {
    if (cliente) return Promise.resolve(cliente);
    // El SDK se sirve empaquetado desde nuestro backend: nada de CDNs de terceros en sitios de clientes
    return import(BASE + "/widget/retell-sdk.mjs").then(function (mod) {
      var C = mod.RetellWebClient || (mod.default && mod.default.RetellWebClient);
      cliente = new C();
      cliente.on("call_ended", function () { terminarLlamada(true); });
      cliente.on("error", function () { aviso("Se cortó la llamada."); terminarLlamada(true); });
      return cliente;
    });
  }
  function terminarLlamada(remota) {
    if (!estado.llamada) return;
    estado.llamada = null;
    if (!remota && cliente) { try { cliente.stopCall(); } catch (e) { /* ya terminó */ } }
    btnLlamar.classList.remove("colgar"); btnLlamar.lastChild.textContent = "Llamar"; btnLlamar.disabled = false;
    aviso("Llamada finalizada.");
  }
  function llamar() {
    if (estado.llamada) { terminarLlamada(false); return; }
    btnLlamar.disabled = true;
    var listo = estado.token ? Promise.resolve() : iniciarSesion();
    listo.then(function () { return pedir("POST", "/llamada-web"); })
      .then(function (d) { return cargarRetell().then(function (c) { estado.llamada = d.call_id; return c.startCall({ accessToken: d.access_token }); }); })
      .then(function () {
        btnLlamar.disabled = false; btnLlamar.classList.add("colgar"); btnLlamar.lastChild.textContent = "Colgar";
        aviso("Llamada en curso: habla con el micrófono.");
      })
      .catch(function (e) { estado.llamada = null; btnLlamar.disabled = false; aviso(e && e.message ? "No se pudo llamar: " + e.message : "No se pudo iniciar la llamada."); });
  }

  // ───────── Eventos ─────────
  function alternar(abrir) {
    estado.abierto = abrir === undefined ? !estado.abierto : abrir;
    panel.classList.toggle("abierto", estado.abierto);
    burbuja.classList.toggle("oculta", estado.abierto);
    burbuja.setAttribute("aria-expanded", String(estado.abierto));
    burbuja.innerHTML = estado.abierto ? SVG.cerrar : SVG.chat;
    burbuja.setAttribute("aria-label", estado.abierto ? "Cerrar chat" : "Abrir chat");
    if (estado.abierto) {
      if (!estado.token && estado.config.pedir_datos) { if (!estado.formulario) formularioPrevio(); }
      else if (!estado.token && !msjs.childNodes.length) iniciarSesion().catch(function (e) { aviso(e.message); });
      setTimeout(function () { entrada.focus(); }, 50);
      sondear();
    }
  }
  burbuja.addEventListener("click", function () { alternar(); });
  btnCerrar.addEventListener("click", function () { alternar(false); burbuja.focus(); });
  btnLlamar.addEventListener("click", llamar);
  pie.addEventListener("submit", function (ev) { ev.preventDefault(); enviar(entrada.value); });
  entrada.addEventListener("input", ajustar);
  entrada.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(entrada.value); }
  });
  panel.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { alternar(false); burbuja.focus(); } });

  // ───────── Arranque ─────────
  pedir("GET", "/config").then(function (cfg) {
    estado.config = cfg;
    var color = /^#[0-9a-fA-F]{3,8}$/.test(cfg.color || "") ? cfg.color : "#0ae98a";
    anfitrion.style.setProperty("--c", color);
    titulo.querySelector("b").textContent = cfg.nombre || cfg.empresa || "Chat";
    if (cfg.voz) btnLlamar.hidden = false;
    document.body.appendChild(anfitrion);
    retomar().then(function () {
      if (script.getAttribute("data-abierto") === "true") alternar(true);
    });
    estado.sondeo = setInterval(sondear, 4000);
  }).catch(function () { /* agente no publicado: el widget no aparece */ });
})();
