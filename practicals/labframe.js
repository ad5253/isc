/* Lab loader. The lab itself is NOT stored on this site: this script checks you are signed in,
   gets a short-lived pass, downloads the private lab from the lab server and shows it in this page
   (so 3D, tracking and the "← Labs" button behave exactly like a normal page). */
(function () {
  // Same protection as the rest of the site: no right-click menu, no developer-tools shortcuts,
  // and the lab is not even downloaded while developer tools are open.
  function exempt() { try { return localStorage.getItem("c12_admin_ok") === "1" || !!window.__c12Admin; } catch (e) { return false; } }
  function lock() {
    document.addEventListener("contextmenu", function (e) {
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (!exempt()) e.preventDefault();
    });
    document.addEventListener("keydown", function (e) {
      if (exempt()) return;
      var k = (e.key || "").toLowerCase(), m = e.ctrlKey || e.metaKey;
      if (e.key === "F12" || (m && e.shiftKey && (k === "i" || k === "j" || k === "c")) || (m && e.altKey && (k === "i" || k === "j" || k === "u")) || (m && k === "u")) e.preventDefault();
    }, true);
  }
  // A "debugger" statement is skipped normally, but pauses the page while developer tools are open.
  function toolsOpen() {
    if (exempt() || document.hidden) return false;
    var t0 = performance.now();
    try { (new Function("debugger;"))(); } catch (e) {}
    return performance.now() - t0 > 150;
  }
  lock();
  var me = document.currentScript;
  var base = me && me.src ? me.src : location.href;
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
  var stat = document.getElementById("lf-status");
  function fail(msg, retry) {
    if (!stat) return;
    stat.style.display = "";
    stat.querySelector(".lf-t").textContent = msg;
    var sp = stat.querySelector(".lf-sp"); if (sp) sp.style.display = "none";
    var b = stat.querySelector("button"); if (b) b.style.display = retry ? "" : "none";
  }
  var cfg = document.createElement("script");
  cfg.src = new URL("config.js", ROOT).href;
  cfg.onload = go;
  cfg.onerror = function () { fail("Could not load. Check your internet and try again.", true); };
  document.head.appendChild(cfg);

  function norm(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }
  function go() {
    if (toolsOpen()) { fail("Close the browser's developer tools, then try again.", true); return; }
    var kind = /\/chemistry\//.test(location.pathname) ? "chemistry" : "physics";
    var slug = location.pathname.replace(/\/index\.html$/, "").replace(/\/+$/, "").split("/").pop();
    var cfgo = (typeof SITE_CONFIG !== "undefined" && SITE_CONFIG) || {};
    var gate = (cfgo.labGate && cfgo.labGate.url) || "https://class12-lab-gate.merchantadnan052.workers.dev";
    var endpoint = cfgo.logging && cfgo.logging.endpoint;
    var who = null; try { who = JSON.parse(sessionStorage.getItem("c12_name") || "null"); } catch (e) {}
    if (!endpoint || !who) { fail("Please sign in again.", false); return; }
    var dt = ""; try { dt = localStorage.getItem("c12_dt_" + norm(who.name)) || ""; } catch (e) {}
    var u = endpoint + "?action=getPdfToken&name=" + encodeURIComponent(who.name) + "&sessionId=" + encodeURIComponent(who.sid || "") + "&pt=" + encodeURIComponent(dt);
    function once(url, ms, opt) {
      var c = new AbortController(), tm = setTimeout(function () { c.abort(); }, ms);
      opt = opt || {}; opt.signal = c.signal;
      return fetch(url, opt).finally(function () { clearTimeout(tm); });
    }
    function getToken() {
      return once(u, 10000).catch(function () { return once(u, 14000); }).then(function (r) { return r.json(); });
    }
    getToken().then(function (d) {
      if (!d || !d.ok || !d.token) {
        if (d && (d.error === "suspended" || d.error === "unauthorized" || d.error === "pin_required")) { location.replace(ROOT.href); return null; }
        throw new Error("token");
      }
      var lu = gate + "/lab/" + kind + "/" + encodeURIComponent(slug) + "?t=" + encodeURIComponent(d.token);
      return once(lu, 40000, { credentials: "omit", cache: "no-store" }).catch(function () { return once(lu, 40000, { credentials: "omit", cache: "no-store" }); }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok || txt.indexOf("<") !== 0 && txt.indexOf("<!") !== 0) throw new Error(txt.slice(0, 160) || ("HTTP " + r.status));
          return txt;
        });
      });
    }).then(function (html) {
      if (html == null) return;
      if (toolsOpen()) { fail("Close the browser's developer tools, then try again.", true); return; }
      var track = '<script src="' + new URL("track.js", base).href + '"><\/script>';
      var i = html.lastIndexOf("</body>");
      html = i >= 0 ? html.slice(0, i) + track + html.slice(i) : html + track;
      document.open(); document.write(html); document.close(); lock();
    }).catch(function (e) {
      var m = String(e && e.message || "");
      fail(m && m !== "token" && m.length < 160 && !/^(Failed|Load failed|NetworkError|The user aborted|signal)/i.test(m) ? m : "Could not open the lab. Check your internet and try again.", true);
    });
  }
})();
