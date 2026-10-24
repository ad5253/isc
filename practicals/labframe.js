/* Lab loader. The lab itself is NOT stored on this site: this script checks you are signed in,
   gets a short-lived pass, downloads the private lab from the lab server and shows it in this page
   (so 3D, tracking and the "← Labs" button behave exactly like a normal page). */
(function () {
  // Same protection as the rest of the site: no right-click menu, no developer-tools shortcuts,
  // and the lab is not even downloaded while developer tools are open.
  // No exemption any more: a browser flag like "I am the admin" can be faked by anyone with a bookmark.
  function exempt() { return false; }
  function lock() {
    window.addEventListener("contextmenu", function (e) {
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (!exempt()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    window.addEventListener("keydown", function (e) {
      if (exempt()) return;
      var k = (e.key || "").toLowerCase(), m = e.ctrlKey || e.metaKey;
      if (e.key === "F12" || (m && e.shiftKey && (k === "i" || k === "j" || k === "c")) || (m && e.altKey && (k === "i" || k === "j" || k === "u")) || (m && k === "u") || (m && k === "s")) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }
  // A "debugger" statement is skipped normally, but pauses the page while developer tools are open.
  function toolsOpen() {
    if (exempt() || document.hidden) return false;
    var t0 = performance.now();
    try { (new Function("debugger;"))(); } catch (e) {}
    return performance.now() - t0 > 400;   // fix #13: longer pause needed, so a slow phone is not mistaken
  }
  // The browser's Print > "Save as PDF" would copy the page, so printing gives a blank page.
  function noPrint() {
    if (exempt()) return;
    try { var st = document.createElement("style"); st.textContent = "@media print{html,body{display:none!important}}"; (document.head || document.documentElement).appendChild(st); } catch (e) {}
  }
  noPrint();
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
    // Fix #21: name, session and proof travel inside the request, not in the web address.
    var passBody = JSON.stringify({ type: "pass", name: who.name, sessionId: who.sid || "", pt: dt, time: new Date().toISOString() });
    function once(url, ms, opt) {
      var c = new AbortController(), tm = setTimeout(function () { c.abort(); }, ms);
      opt = opt || {}; opt.signal = c.signal;
      return fetch(url, opt).finally(function () { clearTimeout(tm); });
    }
    function getToken() {
      var o = function () { return { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: passBody }; };
      return once(endpoint, 10000, o()).catch(function () { return once(endpoint, 14000, o()); }).then(function (r) { return r.json(); });
    }
    getToken().then(function (d) {
      if (d && d.error === "paused") { throw new Error("Too many files were opened too quickly. Please wait 5 minutes and try again."); }
      if (!d || !d.ok || !d.token) {
        if (d && (d.error === "suspended" || d.error === "unauthorized" || d.error === "pin_required")) { location.replace(ROOT.href); return null; }
        throw new Error("token");
      }
      var tail = "/" + kind + "/" + encodeURIComponent(slug);
      var lu = gate + "/lab" + tail, cu = gate + "/code" + tail;
      var lo = function () { return { credentials: "omit", cache: "no-store", headers: { "X-Pass": d.token } }; };   // fix #21: pass in a header
      function hex(u8) { var s = ""; for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16); return s; }
      // 1) the page (3D engine + screens)   2) the lab code, locked for this login   3) the key, only for a live login
      var pPage = once(lu, 40000, lo()).catch(function () { return once(lu, 40000, lo()); }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok || txt.indexOf("<") !== 0 && txt.indexOf("<!") !== 0) throw new Error(txt.slice(0, 160) || ("HTTP " + r.status));
          return txt;
        });
      });
      var pCode = once(cu, 40000, lo()).catch(function () { return once(cu, 40000, lo()); }).then(function (r) {
        if (r.status === 404) return null;                    // lab not split yet: its page carries the code itself
        if (!r.ok) return r.text().then(function (x) { throw new Error(x.slice(0, 160) || ("HTTP " + r.status)); });
        return r.arrayBuffer();
      }).then(function (buf) {
        if (!buf) return null;
        var u = new Uint8Array(buf), nonce = u.slice(0, 16), iv = u.slice(16, 28), ct = u.slice(28);
        return once(gate + "/key" + tail + "?n=" + hex(nonce), 20000, lo()).then(function (r) {
          if (!r.ok) throw new Error("Please sign in again.");
          return r.arrayBuffer();
        }).then(function (kb) {
          return crypto.subtle.importKey("raw", kb, "AES-GCM", false, ["decrypt"]);
        }).then(function (key) {
          return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
        }).then(function (plain) { return new TextDecoder().decode(plain); });
      });
      return Promise.all([pPage, pCode]).then(function (parts) {
        var page = parts[0], code = parts[1];
        if (code == null) return page;
        var tag = 'id="lab-app">', at = page.indexOf(tag);
        if (at < 0) throw new Error("Lab page is incomplete.");
        at += tag.length;
        return page.slice(0, at) + code + page.slice(at);
      });
    }).then(function (html) {
      if (html == null) return;
      if (toolsOpen()) { fail("Close the browser's developer tools, then try again.", true); return; }
      var track = '<script src="' + new URL("track.js", base).href + '"><\/script>';
      var i = html.lastIndexOf("</body>");
      html = i >= 0 ? html.slice(0, i) + track + html.slice(i) : html + track;
      document.open(); document.write(html); document.close(); lock(); noPrint();
    }).catch(function (e) {
      var m = String(e && e.message || "");
      fail(m && m !== "token" && m.length < 160 && !/^(Failed|Load failed|NetworkError|The user aborted|signal)/i.test(m) ? m : "Could not open the lab. Check your internet and try again.", true);
    });
  }
})();
