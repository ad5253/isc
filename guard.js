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

  // The browser's Print > "Save as PDF" would copy what is on the screen, so printing gives a blank page.
  (function noPrint() {
    try {
      var st = document.createElement("style"); st.textContent = "@media print{html,body{display:none!important}}";
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  })();

  // ── 2) developer-tools guard ───────────────────────────────
  var tripped = false;
  // No exemption: a browser flag like "I am the admin" can be faked by anyone with a bookmark.
  function exempt() { return false; }

  function send(name, sid, strike, done) {
    var proof = "";
    try { proof = localStorage.getItem("c12_dt_" + String(name || "").trim().replace(/\s+/g, " ").toLowerCase()) || ""; } catch (e) {}
    var payload = JSON.stringify({
      type: "security", name: name || "", detail: "devtools", dt: proof, time: new Date().toISOString(),
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
    // Fix #13: the count starts again each day, and it only warns/records — it no longer leads to an automatic suspension.
    try {
      var today = new Date().toISOString().slice(0, 10), rec = JSON.parse(localStorage.getItem("c12_dtools_day") || "null");
      strike = ((rec && rec.d === today) ? rec.n : 0) + 1;
      localStorage.setItem("c12_dtools_day", JSON.stringify({ d: today, n: strike }));
    } catch (e) {}
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
  // Fix #13: a slow phone can pause for a moment too, so it must happen twice in a row, and for longer.
  var slowRuns = 0;
  function check() {
    if (tripped || document.hidden || exempt()) { slowRuns = 0; return; }
    var t0 = performance.now();
    try { (new Function("debugger;"))(); } catch (e) {}
    if (performance.now() - t0 > 400) { if (++slowRuns >= 2) trip(); } else slowRuns = 0;
  }
  setInterval(check, 800);
  setTimeout(check, 400);

  // Right-click menu and the usual shortcuts do nothing on the site's pages.
  // Listening on the window, in the capture phase, means nothing on the page (a lab, a viewer)
  // can get in first and switch this off.
  function blockMenu(e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (!exempt()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  function blockKeys(e) {
    if (exempt()) return;
    var k = (e.key || "").toLowerCase(), m = e.ctrlKey || e.metaKey;
    if (e.key === "F12" || e.keyCode === 123 ||
        (m && e.shiftKey && (k === "i" || k === "j" || k === "c" || k === "k")) ||
        (m && e.altKey && (k === "i" || k === "j" || k === "u" || k === "c")) ||
        (m && (k === "u" || k === "s"))) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }
  window.addEventListener("contextmenu", blockMenu, true);
  document.addEventListener("contextmenu", blockMenu, true);
  window.addEventListener("keydown", blockKeys, true);
  document.addEventListener("keydown", blockKeys, true);
})();

/* Screenshot deterrent: the page is covered the moment the window loses focus, the Windows/Cmd key is held
   (screenshot tools start with it), PrintScreen is pressed, or the tab goes to the background. */
(function () {
  if (window.__c12Shot) return; window.__c12Shot = 1;
  var cover = null, held = false, until = 0, tm = 0, blurred = false;
  function make() {
    var d = document.createElement("div");
    d.id = "c12-shot-cover";
    d.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;background:#0b0b0e;color:#d9c48a;display:flex;align-items:center;justify-content:center;text-align:center;font:600 16px system-ui,sans-serif;padding:24px;";
    d.textContent = "Content hidden. Screenshots and screen capture are not allowed on this site.";
    return d;
  }
  function show() {
    if (!cover) cover = make();
    if (!cover.parentNode) (document.body || document.documentElement).appendChild(cover);
  }
  function hide() { if (cover && cover.parentNode) cover.parentNode.removeChild(cover); }
  function update() {
    if (held || blurred || document.hidden || Date.now() < until) show(); else hide();
  }
  function hold(ms) { until = Date.now() + ms; show(); clearTimeout(tm); tm = setTimeout(update, ms + 30); }
  function scrub() {
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText("Screenshots are not allowed on this site."); } catch (e) {}
  }
  window.addEventListener("blur", function () { blurred = true; update(); }, true);
  window.addEventListener("focus", function () { blurred = false; held = false; update(); }, true);
  document.addEventListener("visibilitychange", update, true);
  window.addEventListener("pagehide", show, true);
  window.addEventListener("keydown", function (e) {
    var k = e.key;
    if (k === "Meta" || k === "OS" || k === "Super" || e.metaKey) { held = true; show(); }
    if (k === "PrintScreen" || k === "Snapshot" || e.keyCode === 44) { scrub(); hold(2500); }
  }, true);
  window.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "PrintScreen" || k === "Snapshot" || e.keyCode === 44) { scrub(); hold(2500); }
    if (k === "Meta" || k === "OS" || k === "Super" || !e.metaKey) { if (k === "Meta" || k === "OS" || k === "Super") held = false; }
    update();
  }, true);
  // long-press "save image" and dragging pictures out of the page
  try {
    var st = document.createElement("style");
    st.textContent = "img,canvas,video{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}";
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}
  window.addEventListener("dragstart", function (e) { e.preventDefault(); }, true);
})();
