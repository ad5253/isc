/* Logs which practical a signed-in student opens and for how long.
   Same idea as the PDF viewer: one "view" when it opens, one "view_end"
   with the seconds it was actually on screen. Nothing is logged if the
   student isn't signed in. Add this to every lab page with:
   <script src="../../track.js" defer></script>                          */
(function () {
  var me = document.currentScript;
  var base = me && me.src ? me.src : location.href;
  var cfg = document.createElement("script");
  cfg.src = new URL("../config.js", base).href;
  cfg.onload = start;
  document.head.appendChild(cfg);

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

    function payload(type, extra) {
      return JSON.stringify({
        type: type, name: who.name, detail: detail, time: new Date().toISOString(),
        page: location.href, sessionId: who.sid || "", viewId: viewId,
        duration: extra && extra.duration !== undefined ? extra.duration : ""
      });
    }
    function send(body) {
      try { if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return; } catch (e) {}
      fetch(endpoint, { method: "POST", mode: "no-cors", keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body }).catch(function () {});
    }

    send(payload("view"));

    function finish() {
      if (ended) return;
      if (resumedAt !== null) { activeMs += Date.now() - resumedAt; resumedAt = null; }
      var seconds = Math.round(activeMs / 1000);
      if (seconds >= 3) { ended = true; send(payload("view_end", { duration: seconds })); }
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (resumedAt !== null) { activeMs += Date.now() - resumedAt; resumedAt = null; }
      } else { resumedAt = Date.now(); ended = false; }
    });
    window.addEventListener("pagehide", finish);
  }
})();
