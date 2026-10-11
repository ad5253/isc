/* Adds a small "done" tick to every lab card on the Physics / Chemistry lists.
   Saved on this device and synced with the student's other progress when they
   use the main site. Only shown when someone is signed in. */
(function () {
  var who;
  try { who = JSON.parse(sessionStorage.getItem("c12_name") || "null"); } catch (e) {}
  if (!who || !who.name) return;
  var n = String(who.name).trim().replace(/\s+/g, " ").toLowerCase();
  var KEY = "c12_labs_" + n;
  var subj = /\/chemistry\/?$/.test(location.pathname) ? "chemistry" : "physics";
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
  var cards = document.querySelectorAll("#expList a.subfolder");
  var summary = document.createElement("p");
  summary.className = "page-note lab-summary";
  var list = document.getElementById("expList");
  list.parentNode.insertBefore(summary, list);
  function paint() {
    var done = load(), c = 0;
    cards.forEach(function (a) {
      var id = subj + "/" + a.getAttribute("href").replace(/\/$/, "");
      var on = done.indexOf(id) !== -1; if (on) c++;
      var b = a.querySelector(".lab-tick");
      b.classList.toggle("lab-tick--on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.title = on ? "Marked as done" : "Mark as done";
    });
    summary.textContent = c + " of " + cards.length + " labs done";
  }
  cards.forEach(function (a) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "lab-tick"; b.setAttribute("aria-label", "Mark this lab as done");
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>';
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      var id = subj + "/" + a.getAttribute("href").replace(/\/$/, "");
      var d = load(), i = d.indexOf(id);
      if (i === -1) d.push(id); else d.splice(i, 1);
      save(d); paint();
    });
    var ch = a.querySelector(".subfolder__chevron");
    a.insertBefore(b, ch);
  });
  paint();
})();
