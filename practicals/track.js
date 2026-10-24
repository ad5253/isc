/* Used by every lab page (added with:  <script src="../../track.js" defer></script>).
   1) Sends signed-out visitors to the login page.
   2) Logs which practical a signed-in student opens and for how long, plus how smoothly
      the lab ran on their device (so the admin can see which lab or phone struggles).
   3) Shows a friendly message if 3D graphics don't work, and a "rotate your phone" hint.
   It only ADDS things on top of the lab; it never changes the lab's own code. */
(function () {
  var me = document.currentScript;
  var base = me && me.src ? me.src : location.href;

  // ── 1) sign-in check ──────────────────────────────────────
  var ROOT = new URL("../", base);
  function signedIn() {
    try {
      var s = JSON.parse(sessionStorage.getItem("c12_name") || "null");
      var min = Number(localStorage.getItem("c12_expmin")) || 15;
      return !!(s && s.name && s.ts && Date.now() - s.ts <= min * 60000);
    } catch (e) { return false; }
  }
  if (!signedIn()) {
    document.documentElement.style.display = "none";
    var p = location.pathname.slice(ROOT.pathname.length).replace(/index\.html$/, "");
    location.replace(ROOT.href + "?next=" + encodeURIComponent(p));
    return;
  }

  if (typeof SITE_CONFIG !== "undefined") { setTimeout(start, 0); }   // already loaded (lab opened through the lab loader)
  else {
    var cfg = document.createElement("script");
    cfg.src = new URL("../config.js", base).href;
    cfg.onload = start;
    document.head.appendChild(cfg);
  }
  // Same site guard as every other page (keeps the sign-in alive, blocks developer tools).
  var gd = document.createElement("script");
  gd.src = new URL("../guard.js", base).href;
  document.head.appendChild(gd);

  // ── 3) friendly messages (no lab code touched) ─────────────
  var probeCanvas = null, env = { gl: 1, gpu: "" };
  try {
    probeCanvas = document.createElement("canvas");
    var g = probeCanvas.getContext("webgl") || probeCanvas.getContext("experimental-webgl");
    if (!g) env.probeFail = 1;
    else {
      var ext = g.getExtension("WEBGL_debug_renderer_info");
      env.gpu = String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER) || "").replace(/[|:]/g, " ").slice(0, 60);
    }
  } catch (e) { env.probeFail = 1; }

  function overlay(title, text, withReload) {
    if (document.getElementById("c12-labmsg")) return;
    var d = document.createElement("div");
    d.id = "c12-labmsg";
    d.setAttribute("role", "alert");
    d.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#0b0f1a;color:#e8ecf4;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center";
    var box = document.createElement("div");
    box.style.cssText = "max-width:420px";
    var h = document.createElement("div"); h.textContent = title; h.style.cssText = "font-size:20px;font-weight:700;margin-bottom:10px";
    var t = document.createElement("div"); t.textContent = text; t.style.cssText = "font-size:15px;line-height:1.55;opacity:.85;margin-bottom:18px";
    var row = document.createElement("div"); row.style.cssText = "display:flex;gap:10px;justify-content:center;flex-wrap:wrap";
    var back = document.createElement("a"); back.href = "../"; back.textContent = "← Back to labs";
    back.style.cssText = "color:#38bdf8;border:1px solid rgba(56,189,248,.5);border-radius:999px;padding:9px 16px;text-decoration:none;font-weight:700;font-size:14px";
    row.appendChild(back);
    if (withReload) {
      var rl = document.createElement("button"); rl.type = "button"; rl.textContent = "Reload";
      rl.style.cssText = "background:#38bdf8;color:#06111c;border:0;border-radius:999px;padding:9px 18px;font-weight:700;font-size:14px;cursor:pointer";
      rl.onclick = function () { location.reload(); };
      row.appendChild(rl);
    }
    box.appendChild(h); box.appendChild(t); box.appendChild(row); d.appendChild(box);
    (document.body || document.documentElement).appendChild(d);
  }
  // (If 3D is really missing, the lab shows its own message; this page never blocks the lab on a pre-test.)
  // Raised by the browser if the lab's own 3D view can't start or is lost.
  document.addEventListener("webglcontextcreationerror", function (e) {
    if (e.target === probeCanvas) return;
    overlay("The 3D view could not start", "Close other tabs and apps, then reload. If it keeps happening, open the site directly in Chrome or Safari.", true);
  }, true);
  var lostTimer = 0;
  document.addEventListener("webglcontextlost", function (e) {
    if (e.target === probeCanvas) return;
    clearTimeout(lostTimer);
    lostTimer = setTimeout(function () {
      overlay("The 3D view stopped", "The phone ran out of graphics memory. Close other tabs and apps, then reload.", true);
    }, 3500);
  }, true);
  document.addEventListener("webglcontextrestored", function () { clearTimeout(lostTimer); }, true);

  // "Rotate your phone" hint: small phones in portrait only, once per visit, never blocks anything.
  try {
    var small = Math.min(screen.width, screen.height) < 700 && matchMedia("(pointer:coarse)").matches;
    if (small && env.gl && !sessionStorage.getItem("c12_rot")) {
      var portrait = matchMedia("(orientation:portrait)");
      var hint = null, hideT = 0;
      var hide = function () { if (hint) { hint.remove(); hint = null; } clearTimeout(hideT); };
      var show = function () {
        if (hint || !portrait.matches) return;
        hint = document.createElement("div");
        hint.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147482000;background:rgba(11,15,26,.92);color:#e8ecf4;border:1px solid rgba(56,189,248,.5);border-radius:999px;padding:8px 14px;font:600 13px system-ui,-apple-system,sans-serif;pointer-events:none;white-space:nowrap";
        hint.textContent = "↻ Turn your phone sideways for a bigger lab";
        document.body.appendChild(hint);
        try { sessionStorage.setItem("c12_rot", "1"); } catch (e) {}
        hideT = setTimeout(hide, 7000);
      };
      var onOrient = function () { if (!portrait.matches) hide(); };
      if (portrait.addEventListener) portrait.addEventListener("change", onOrient);
      setTimeout(show, 2500);
    }
  } catch (e) {}

  // ── 2) tracking ───────────────────────────────────────────
  function start() {
    var endpoint, who;
    try {
      endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
      who = JSON.parse(sessionStorage.getItem("c12_name") || "null");
    } catch (e) { return; }
    if (!endpoint || !who || !who.name) return;

    var title = (document.title || "Practical")
      .replace(/\s*\|.*$/, "")
      .replace(/^Experiment\s*\d+\s*:\s*/i, "");
    var detail = "Practical: " + title;
    var viewId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var activeMs = 0;
    var resumedAt = document.hidden ? null : Date.now();
    var ended = false;

    var proof = ""; try { proof = localStorage.getItem("c12_dt_" + String(who.name).trim().replace(/\s+/g, " ").toLowerCase()) || ""; } catch (e) {}
    function payload(type, extra) {
      return JSON.stringify({
        type: type, name: who.name, detail: detail, time: new Date().toISOString(),
        page: (extra && extra.page) || location.href, sessionId: who.sid || "", viewId: viewId,
        duration: extra && extra.duration !== undefined ? extra.duration : "",
        eventId: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),   // fix #25: a repeat is ignored by the server
        dt: proof || undefined
      });
    }
    // Fix #25: confirmed delivery for the lab "opened" row; the "closed" row (sent while the page is
    // going away) is sent with sendBeacon and a copy is kept to re-send next time (the server ignores repeats).
    function keep(k, body) { try { var a = JSON.parse(localStorage.getItem(k) || "[]"); if (!Array.isArray(a)) a = []; a.push({ p: body, at: Date.now() }); localStorage.setItem(k, JSON.stringify(a.slice(-150))); } catch (e) {} }
    function send(body, closing) {
      if (closing) {
        keep("c12_logu", body);
        try { if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return; } catch (e) {}
        fetch(endpoint, { method: "POST", mode: "no-cors", keepalive: true,
          headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body }).catch(function () {});
        return;
      }
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (!d || !d.ok) keep("c12_logq", body); })
        .catch(function () { keep("c12_logq", body); });
    }

    send(payload("view"));

    // How smooth the lab runs: frames per second, measured once a second while the tab is visible.
    var samples = [], frames = 0, lastT = 0;
    function tick(ts) {
      if (document.hidden) { lastT = 0; frames = 0; }
      else {
        if (!lastT) { lastT = ts; frames = 0; }
        frames++;
        if (ts - lastT >= 1000) {
          samples.push(frames * 1000 / (ts - lastT));
          frames = 0; lastT = ts;
          if (samples.length > 900) samples.shift();
        }
      }
      requestAnimationFrame(tick);
    }
    if (env.gl) requestAnimationFrame(tick);

    function deviceLabel() {
      var ua = navigator.userAgent || "", m;
      if ((m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build|[;)])/))) return m[1].replace(/[|:]/g, " ").slice(0, 40);
      if (/iPhone/.test(ua)) return "iPhone";
      if (/iPad/.test(ua)) return "iPad";
      if (/Windows/.test(ua)) return "Windows PC";
      if (/Macintosh/.test(ua)) return "Mac";
      if (/CrOS/.test(ua)) return "Chromebook";
      if (/Linux/.test(ua)) return "Linux";
      return "other";
    }
    function perfPayload() {
      var s = samples.slice(3);           // ignore the first seconds while the lab is still loading
      if (s.length < 5) return null;
      s.sort(function (a, b) { return a - b; });
      var med = s[Math.floor(s.length / 2)], p10 = s[Math.floor(s.length * 0.1)];
      var low = s.filter(function (x) { return x < 20; }).length;
      var page = location.href + " || fps:" + Math.round(med) + "|p10:" + Math.round(p10) + "|low:" + Math.round(100 * low / s.length) +
        "|n:" + s.length + "|gpu:" + env.gpu + "|dev:" + deviceLabel() + "|mem:" + (navigator.deviceMemory || "") +
        "|cores:" + (navigator.hardwareConcurrency || "") + "|dpr:" + (Math.round((window.devicePixelRatio || 1) * 10) / 10) +
        "|scr:" + screen.width + "x" + screen.height;
      return payload("labperf", { page: page });
    }

    function finish() {
      if (ended) return;
      if (resumedAt !== null) { activeMs += Date.now() - resumedAt; resumedAt = null; }
      var seconds = Math.round(activeMs / 1000);
      if (seconds >= 3) {
        ended = true; send(payload("view_end", { duration: seconds }), true);
        var pp = perfPayload(); if (pp) send(pp, true);
      }
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (resumedAt !== null) { activeMs += Date.now() - resumedAt; resumedAt = null; }
      } else { resumedAt = Date.now(); ended = false; }
    });
    window.addEventListener("pagehide", finish);
  }
})();
