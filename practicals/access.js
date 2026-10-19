/* Sign-in check for the Practicals list pages.
   Anyone who is not signed in is sent to the login page (and brought back here afterwards).
   Loaded in the <head> so the page never shows to a signed-out visitor.
   Labs do the same check inside track.js. */
(function () {
  var me = document.currentScript;
  if (!me || !me.src) return;
  var ROOT = new URL("../", me.src);
  function signedIn() {
    try {
      var s = JSON.parse(sessionStorage.getItem("c12_name") || "null");
      var min = Number(localStorage.getItem("c12_expmin")) || 15;
      return !!(s && s.name && s.ts && Date.now() - s.ts <= min * 60000);
    } catch (e) { return false; }
  }
  if (signedIn()) return;
  document.documentElement.style.display = "none";
  var path = location.pathname.slice(ROOT.pathname.length).replace(/index\.html$/, "");
  location.replace(ROOT.href + "?next=" + encodeURIComponent(path));
})();
