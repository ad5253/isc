/* Site guard — loaded on every page of the portal.
   1) Keeps the sign-in alive while someone is using ANY page (home, practicals, labs),
      so moving between them never logs the student out.
   2) Detects open browser developer tools: signs the person out, records it against
      their name, shows a warning, and suspends the account if it happens again.
   This is a deterrent, not a lock — the PDFs themselves stay protected by the server. */
(function () {
  if (window.__c12Guard) return;
  window.__c12Guard = true;
  var me = document.currentScript;
  var ROOT = new URL("./", me && me.src ? me.src : location.href).href;

  function readS() { try { return JSON.parse(sessionStorage.getItem("c12_name") || "null"); } catch (e) { return null; } }

  // ── 1) keep the sign-in alive ──────────────────────────────
  var lastTouch = 0;
  function touch() {
    var now = Date.now();
    if (now - lastTouch < 15000) return;
    lastTouch = now;
    var s = readS();
    if (s && s.name) { s.ts = now; try { sessionStorage.setItem("c12_name", JSON.stringify(s)); } catch (e) {} }
  }
  ["pointerdown", "keydown", "touchstart", "wheel", "scroll", "mousemove"].forEach(function (ev) {
    window.addEventListener(ev, touch, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) touch(); });
  touch();

  // ── 2) developer-tools guard ───────────────────────────────
  var tripped = false;
  function exempt() {
    try { if (localStorage.getItem("c12_admin_ok") === "1") return true; } catch (e) {}
    return !!window.__c12Admin;
  }

  function send(name, sid, strike, done) {
    var payload = JSON.stringify({
      type: "security", name: name || "", detail: "devtools", time: new Date().toISOString(),
      page: location.href + " || strike:" + strike, sessionId: sid || "", viewId: "", duration: ""
    });
    function go(ep) {
      try { if (navigator.sendBeacon && navigator.sendBeacon(ep, payload)) return done(); } catch (e) {}
      try { fetch(ep, { method: "POST", mode: "no-cors", keepalive: true, headers: { "Content-Type": "text/plain;charset=utf-8" }, body: payload }).catch(function () {}); } catch (e) {}
      setTimeout(done, 250);
    }
    function withCfg() {
      var cfg = null;
      try { cfg = (typeof SITE_CONFIG !== "undefined") ? SITE_CONFIG : null; } catch (e) {}
      var ep = cfg && cfg.logging && cfg.logging.endpoint;
      if (ep && ep.indexOf("PASTE_YOUR") !== 0) go(ep); else done();
    }
    var have = false;
    try { have = typeof SITE_CONFIG !== "undefined"; } catch (e) {}
    if (have) return withCfg();
    var sc = document.createElement("script");
    sc.src = ROOT + "config.js";
    sc.onload = withCfg; sc.onerror = done;
    document.head.appendChild(sc);
    setTimeout(done, 1800);
  }

  function trip() {
    if (tripped || exempt()) return;
    tripped = true;
    var s = readS();
    var strike = 1;
    try { strike = (Number(localStorage.getItem("c12_dtools")) || 0) + 1; localStorage.setItem("c12_dtools", String(strike)); } catch (e) {}
    var finished = false;
    function finish() {
      if (finished) return; finished = true;
      try {
        if (s && s.name) {
          var n = String(s.name).trim().replace(/\s+/g, " ").toLowerCase();
          localStorage.removeItem("c12_dt_" + n);
        }
        sessionStorage.removeItem("c12_name");
        sessionStorage.removeItem("c12_tm");
        localStorage.removeItem("c12_keep");
        localStorage.setItem("c12_guard_msg", JSON.stringify({ t: Date.now(), strike: strike }));
      } catch (e) {}
      location.replace(ROOT);
    }
    send(s && s.name, s && s.sid, strike, finish);
  }

  // A `debugger` statement does nothing normally, but freezes the page while developer tools are
  // open — so a long pause between before/after means they are open.
  function check() {
    if (tripped || document.hidden || exempt()) return;
    var t0 = performance.now();
    try { (new Function("debugger;"))(); } catch (e) {}
    if (performance.now() - t0 > 150) trip();
  }
  setInterval(check, 1200);
  setTimeout(check, 400);

  // Right-click menu and the usual shortcuts do nothing on the site's pages.
  document.addEventListener("contextmenu", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (!exempt()) e.preventDefault();
  });
  document.addEventListener("keydown", function (e) {
    if (exempt()) return;
    var k = (e.key || "").toLowerCase();
    if (e.key === "F12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "i" || k === "j" || k === "c")) || ((e.ctrlKey || e.metaKey) && e.altKey && (k === "i" || k === "j" || k === "u")) || ((e.ctrlKey || e.metaKey) && k === "u")) {
      e.preventDefault();
    }
  }, true);
})();
