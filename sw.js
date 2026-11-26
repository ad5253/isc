/* ISC Class 12 - service worker.
   Purpose: lets Android install the site as an app and shows a friendly page when offline.
   SAFETY RULES (do not change lightly):
   - It only touches files from this site itself. Login, payment, the PDF gate, the lab gate and every
     other server (script.google.com, *.workers.dev ...) are NEVER touched: those requests go straight to the network.
   - Web pages (HTML) are never saved, so the site is always the newest version.
   - To switch it off for everybody: replace this whole file with the "kill switch" at the bottom of README_INSTALL_APP.txt. */
var VERSION = "isc-v1";
var STATIC = VERSION + "-static";
var OFFLINE_URL = "offline.html";

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(STATIC).then(function (c) {
    return Promise.all([OFFLINE_URL, "icon-192.png", "favicon.svg"].map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(VERSION) !== 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function putCopy(req, res) {
  if (res && res.ok && res.type === "basic") { var copy = res.clone(); caches.open(STATIC).then(function (c) { c.put(req, copy); }).catch(function () {}); }
  return res;
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                       // other servers: not our business
  if (url.pathname.indexOf("/pay/") !== -1 || /\/sw\.js$/.test(url.pathname)) return;   // payment pages + this file: network only

  // Pages: always the live version; offline page only if the network is truly down.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(function () { return caches.match(OFFLINE_URL, { cacheName: STATIC }); }));
    return;
  }

  var ext = (url.pathname.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  // Code and settings: network first (so updates always win), saved copy only when offline.
  if (ext === "js" || ext === "css" || ext === "json") {
    e.respondWith(fetch(req).then(function (res) { return putCopy(req, res); }).catch(function () { return caches.match(req, { cacheName: STATIC }); }));
    return;
  }
  // Fonts and pictures: show the saved copy instantly, refresh it quietly.
  if (/^(woff2?|png|jpg|jpeg|svg|ico|webp)$/.test(ext)) {
    e.respondWith(caches.match(req, { cacheName: STATIC }).then(function (hit) {
      var net = fetch(req).then(function (res) { return putCopy(req, res); }).catch(function () { return hit; });
      return hit || net;
    }));
  }
  // everything else (PDFs, videos, ...): not handled -> normal network
});
