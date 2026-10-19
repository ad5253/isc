/* Makes the header, footer and bottom bar on the Practicals pages behave exactly like the
   main site's: same buttons, same places they lead to, and Home never signs anyone out. */
(function () {
  var me = document.currentScript;
  var ROOT = new URL("../", me && me.src ? me.src : location.href).href;
  function readS() { try { return JSON.parse(sessionStorage.getItem("c12_name") || "null"); } catch (e) { return null; } }
  function norm(n) { return String(n || "").trim().replace(/\s+/g, " ").toLowerCase(); }
  function $(s) { return document.querySelector(s); }
  var s = readS(), signedIn = !!(s && s.name);

  // greeting + things that only make sense when signed in
  var g = $("#greeting"); if (g && signedIn) g.textContent = "Hi, " + s.name;
  if (!signedIn) {
    ["#progressBtn", "#logoutBtn", "#greeting"].forEach(function (q) { var e = $(q); if (e) e.style.display = "none"; });
  }

  // light / dark
  function theme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  var tb = $("#themeBtn");
  if (tb) tb.addEventListener("click", function () {
    var root = document.documentElement, t = theme() === "light" ? "dark" : "light";
    root.classList.add("theme-fade");
    if (t === "light") root.setAttribute("data-theme", "light"); else root.removeAttribute("data-theme");
    try { localStorage.setItem("c12_theme", t); } catch (e) {}
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "light" ? "#f6f2e9" : "#121218");
    setTimeout(function () { root.classList.remove("theme-fade"); }, 450);
  });

  // go back to the main site (the sign-in travels with the tab, and guard.js keeps it fresh)
  function go(qs) { location.href = ROOT + (qs || ""); }
  var pb = $("#progressBtn"); if (pb) pb.addEventListener("click", function () { go("?view=progress"); });
  var si = $("#searchInput");
  if (si) si.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && si.value.trim()) { e.preventDefault(); go("?q=" + encodeURIComponent(si.value.trim())); }
  });
  var lo = $("#logoutBtn");
  if (lo) lo.addEventListener("click", function () {
    if (!confirm("Sign out of Class 12?")) return;
    try { if (s && s.name) localStorage.removeItem("c12_dt_" + norm(s.name)); sessionStorage.removeItem("c12_name"); sessionStorage.removeItem("c12_tm"); } catch (e) {}
    go("");
  });
  var tab = $("#tabbar");
  if (tab) tab.addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]"); if (!b) return;
    var t = b.dataset.tab;
    if (t === "home") go("");
    else if (t === "progress") go("?view=progress");
    else if (t === "search") go("?view=search");
    else window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();
