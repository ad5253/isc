/* ISC Class 12 - "install the app" helper.
   Android (Chrome/Edge/Samsung): small bar -> one tap -> the phone's own Install dialog -> done.
   iPhone/iPad: Apple does not allow websites to install themselves, so a small bar shows the two taps.
   Rules: never on the login screen or payment window, never while typing, never inside the installed app,
   "Not now" hides it for 14 days, installing hides it for good. */
(function () {
  "use strict";
  if (window.__c12Install) return;
  window.__c12Install = true;

  var KEY = "c12_install_v1", DAY = 86400000;
  var DELAY = typeof window.C12_INSTALL_DELAY === "number" ? window.C12_INSTALL_DELAY : 8000;    // wait before the first ask
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } }
  function write(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }

  var secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if ("serviceWorker" in navigator && secure) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" }).then(function (reg) {
        document.addEventListener("visibilitychange", function () { if (!document.hidden) { try { reg.update(); } catch (e) {} } });
      }).catch(function () {});
    });
  }

  var standalone = false;
  try { standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; } catch (e) {}
  if (standalone) return;

  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var iosSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios|opios|gsa\/|instagram|fban|fbav|line\//i.test(ua);
  if (!(isIOS || /android|mobile/i.test(ua))) return;   // phones and tablets only: no pop-up on laptops
  var deferred = null, shown = false, t0 = Date.now(), poll = null;

  function snoozed() { var s = read(); return s.done || (s.until && Date.now() < s.until); }
  function snooze(days) { var s = read(); s.until = Date.now() + days * DAY; write(s); }
  function finish() { var s = read(); s.done = true; write(s); }

  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener("appinstalled", function () { finish(); hide(); });

  function hiddenEl(id) { var el = document.getElementById(id); return !el || el.classList.contains("hidden"); }
  function quiet() {
    if (document.hidden) return false;
    if (!hiddenEl("payModal")) return false;            // payment window open (the login screen is fine: that is where people arrive)
    var a = document.activeElement; if (a && /^(input|textarea|select)$/i.test(a.tagName) && (a.value || "").length) return false;   // someone is typing
    if (document.documentElement.classList.contains("resuming")) return false;
    return true;
  }

  var bar = null;
  function hide() { if (bar) { bar.remove(); bar = null; } shown = false; if (poll) { clearInterval(poll); poll = null; } }
  function css() {
    if (document.getElementById("c12InstallCss")) return;
    var s = document.createElement("style"); s.id = "c12InstallCss";
    s.textContent = "#c12Install{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:1500;max-width:460px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:12px 12px 12px 14px;border-radius:18px;background:#1c1c25;color:#f4f1e8;border:1px solid rgba(201,161,90,.35);box-shadow:0 14px 40px rgba(0,0,0,.45);font:14px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;animation:c12up .35s ease-out}" +
      "#c12Install img{width:44px;height:44px;border-radius:11px;flex:none}#c12Install .t{flex:1;min-width:0}#c12Install b{display:block;font-size:15px;margin-bottom:2px}#c12Install span.s{color:rgba(244,241,232,.72);font-size:13px}" +
      "#c12Install button{font:600 14px system-ui,sans-serif;border:0;border-radius:999px;cursor:pointer;padding:10px 16px;min-height:40px}#c12Install .go{background:#c9a15a;color:#17120a}#c12Install .no{background:transparent;color:rgba(244,241,232,.65);padding:10px 8px}" +
      "#c12Install svg{vertical-align:-3px;margin:0 1px}@keyframes c12up{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}@media (prefers-reduced-motion:reduce){#c12Install{animation:none}}";
    document.head.appendChild(s);
  }
  var SHARE = "<svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='#c9a15a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M12 3v12M8 7l4-4 4 4M5 11v9h14v-9'/></svg>";
  function show(kind) {
    if (shown) return; shown = true; css();
    bar = document.createElement("div"); bar.id = "c12Install"; bar.setAttribute("role", "dialog"); bar.setAttribute("aria-label", "Install ISC Class 12");
    var html = "<img src='icon-192.png' alt=''><div class='t'>";
    if (kind === "android") html += "<b>Install ISC Class 12</b><span class='s'>Opens like an app and keeps you signed in on your own phone.</span></div><button class='no' type='button'>Not now</button><button class='go' type='button'>Install</button>";
    else if (kind === "ios") html += "<b>Get the app</b><span class='s'>Stay signed in on your phone. Tap " + SHARE + " Share, then <b style='display:inline;font-size:13px'>Add to Home Screen</b>.</span></div><button class='go' type='button'>Got it</button>";
    else html += "<b>Get the app</b><span class='s'>Open this page in <b style='display:inline;font-size:13px'>Safari</b>, tap " + SHARE + " Share, then Add to Home Screen.</span></div><button class='go' type='button'>Got it</button>";
    bar.innerHTML = html; document.body.appendChild(bar);
    var go = bar.querySelector(".go"), no = bar.querySelector(".no");
    if (no) no.addEventListener("click", function () { snooze(5); hide(); });
    go.addEventListener("click", function () {
      if (kind !== "android") { snooze(30); hide(); return; }
      var d = deferred; deferred = null; hide();
      if (!d) return;
      try { d.prompt(); (d.userChoice || Promise.resolve({})).then(function (c) { if (c && c.outcome === "accepted") finish(); else snooze(14); }); } catch (e) { snooze(14); }
    });
  }

  function tick() {
    if (shown || snoozed()) { if (snoozed()) hide(); return; }
    if (Date.now() - t0 < DELAY || !quiet()) return;
    if (isIOS) show(iosSafari ? "ios" : "ios-other");
    else if (deferred) show("android");
  }
  poll = setInterval(tick, Math.min(3000, Math.max(200, DELAY / 2)));
})();
