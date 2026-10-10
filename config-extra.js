// Optional speed-up. Paste your API-cache Worker address between the
// quotes (e.g. "https://class12-api-cache.yourname.workers.dev").
// Leave it empty and the site simply talks to Google directly, as before.
(function () {
  if (typeof SITE_CONFIG === "undefined") return;
  SITE_CONFIG.apiCache = { url: "" };
})();
