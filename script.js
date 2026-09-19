// ============================================================
//  CLASS 12 — STUDY INDEX — CORE LOGIC
//  Name gate · Navigation · PDF thumbnails · Viewer · Logging
// ============================================================

(function () {
  "use strict";

  // ── PDF.js setup ───────────────────────────────────────
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // A folder's thumbnails and the full viewer used to each call
  // pdfjsLib.getDocument() independently — meaning a 30–40MB scanned
  // PDF got fully fetched and parsed once for its thumbnail, then
  // AGAIN from scratch the moment someone clicked to actually view it.
  // This cache keeps the one loading task per file for the whole
  // session, so opening the viewer after its thumbnail has already
  // rendered reuses the same in-flight/completed load instead of
  // starting over. Session-scoped only — closing the tab clears it,
  // same as browser memory generally.
  // Wraps any promise with a hard deadline — pdf.js doesn't always turn
  // a stalled/blocked request into a clean rejection, it sometimes just
  // hangs forever, and a hung promise anywhere in this file was the
  // actual cause behind three different-looking symptoms: a folder's
  // thumbnails crawling (one stuck request permanently occupying a
  // concurrency slot), a PDF opening to a totally blank screen with no
  // error (nothing downstream of the hung call ever got a chance to
  // run), and jumping to a page that then never loads (its "currently
  // rendering" flag never got cleared, so every retry silently no-oped
  // forever). Every render path below is now wrapped with this.
  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message || "Timed out")), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  const pdfLoadingTasks = new Map();
  function getPdfLoadingTask(path) {
    if (!pdfLoadingTasks.has(path)) {
      pdfLoadingTasks.set(path, makePdfLoadingTask(path));
    }
    return pdfLoadingTasks.get(path);
  }

  // Building the request URL now needs an async token fetch first
  // (see ensurePdfToken above), but existing callers set `.onProgress`
  // synchronously right after calling getPdfLoadingTask and then read
  // `.promise` — so this returns a task-shaped object immediately,
  // and wires the real pdf.js task's progress through to it once the
  // token is ready and the real load has actually started.
  //
  // If the load fails (bad token, Worker/Backblaze hiccup, momentary
  // network issue...), the failed entry used to stay in this Map for
  // the rest of the browser session — so a transient failure looked
  // permanent: every future click on that same file replayed the same
  // rejected promise instead of trying again. Now a failure evicts its
  // own cache entry, so the next click on that file starts a genuinely
  // fresh load.
  //
  // A 25-second hard timeout was added here too, for a real bug this
  // was masking: on a folder with several files, thumbnails load 4 at
  // a time (see THUMBNAIL_CONCURRENCY below) — and each one calls the
  // Worker, which itself range-requests the file from Backblaze
  // multiple times per document, not once. That was blowing through
  // the Worker's old per-minute request limit within the first few
  // thumbnails, and pdf.js doesn't always turn a stalled/rate-limited
  // connection into a clean rejection — sometimes it just hangs. A
  // hung promise here never resolves OR rejects, so it never freed its
  // slot in the concurrency queue below, which is exactly what made
  // "only a few thumbnails load, the rest just sit there forever"
  // happen: the queue wasn't broken, it was permanently stuck waiting
  // on tasks that were never going to finish. This timeout forces any
  // such hang to fail cleanly instead, freeing its slot and letting
  // the file's own existing "click to open" behavior serve as a real
  // retry once it's evicted from the cache below.
  function makePdfLoadingTask(path) {
    const task = { onProgress: null };
    let realTask = null; // captured once created, so a timeout can properly destroy() it instead of just walking away and leaving it running in the background — which would keep eating memory even after this code has given up on it, compounding exactly the RAM pressure this is meant to fix
    let timedOut = false;

    const realLoadPromise = ensurePdfToken().then((token) => {
      realTask = pdfjsLib.getDocument(pdfWorkerUrl(path, token));
      realTask.onProgress = (p) => { if (task.onProgress) task.onProgress(p); };
      return realTask.promise;
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        timedOut = true;
        if (realTask) realTask.destroy();
        reject(new Error("PDF load timed out"));
      }, 25000);
    });

    task.promise = Promise.race([realLoadPromise, timeoutPromise]).catch((err) => {
      if (pdfLoadingTasks.get(path) === task) pdfLoadingTasks.delete(path);
      throw err;
    });
    // If the real load actually succeeds AFTER we've already given up
    // and moved on, still destroy() the now-unwanted document rather
    // than let it sit in memory unused — nothing holds a reference to
    // it once the timeout has already rejected task.promise.
    realLoadPromise.then((pdf) => { if (timedOut) pdf.destroy(); }).catch(() => {});
    return task;
  }

  // ── Thumbnail lazy-load + concurrency throttle ─────────
  // Opening a folder used to fire off a full pdf.js load for EVERY
  // file in it at once, which could genuinely choke a connection on
  // a folder with many large files. But capping it too low backfires
  // just as badly: with only a couple of slots open, a small file
  // sitting near the back of an 8-file folder has to wait for
  // several bigger files ahead of it to finish before it even starts
  // — so a quick 4MB file can *look* like it took 45 seconds when
  // really it spent most of that time queued, not downloading.
  // 4 concurrent is a better balance for realistic folder sizes here
  // (single digits to ~17MB each) — enough parallelism that nothing
  // sits queued for long, while still well short of firing off every
  // file in a folder simultaneously.
  const THUMBNAIL_CONCURRENCY = 4;
  let activeThumbnailLoads = 0;
  const thumbnailQueue = [];

  function queueThumbnailLoad(task) {
    thumbnailQueue.push(task);
    drainThumbnailQueue();
  }

  function drainThumbnailQueue() {
    while (activeThumbnailLoads < THUMBNAIL_CONCURRENCY && thumbnailQueue.length) {
      const task = thumbnailQueue.shift();
      activeThumbnailLoads++;
      task().finally(() => {
        activeThumbnailLoads--;
        drainThumbnailQueue();
      });
    }
  }

  let thumbObserver = null;
  function observeThumbnail(target, path, canvas, skeleton) {
    if (!("IntersectionObserver" in window)) {
      // No IntersectionObserver support — fall back to loading
      // immediately (still throttled by the concurrency queue above).
      queueThumbnailLoad(() => renderThumbnail(path, canvas, skeleton));
      return;
    }
    if (!thumbObserver) {
      thumbObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            thumbObserver.unobserve(entry.target);
            const data = entry.target.__thumbData;
            if (data) queueThumbnailLoad(() => renderThumbnail(data.path, data.canvas, data.skeleton));
          });
        },
        { rootMargin: "300px 0px", threshold: 0.01 }
      );
    }
    target.__thumbData = { path, canvas, skeleton };
    thumbObserver.observe(target);
  }

  // ── Line icons (no emoji) ───────────────────────────────
  const ICONS = {
    maths: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4.2 20h15.6z"/><path d="M12 3v17"/><circle cx="12" cy="3" r="1" fill="currentColor" stroke="none"/></svg>`,
    physics: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="12" cy="12" rx="9.2" ry="3.6"/><ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    chemistry: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h5"/><path d="M10.3 2.5v6.4L4.6 18.8a1.6 1.6 0 0 0 1.4 2.4h12a1.6 1.6 0 0 0 1.4-2.4L13.7 8.9V2.5"/><path d="M7.6 15.3h8.8"/></svg>`,
    folder: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    doc: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    tray: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 12 3.5 6.4A1.6 1.6 0 0 1 5 4.5h14a1.6 1.6 0 0 1 1.5 1.9L19 12v5.4A1.6 1.6 0 0 1 17.4 19H6.6A1.6 1.6 0 0 1 5 17.4z"/></svg>`,
    star: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2.5 15.1 9 22 10 17 15 18.2 22 12 18.6 5.8 22 7 15 2 10 8.9 9"/></svg>`
  };

  // ── DOM refs ───────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const gate        = $("#gate");
  const nameForm    = $("#nameForm");
  const nameInput   = $("#nameInput");
  const app         = $("#app");
  const homeBtn     = $("#homeBtn");
  const progressBtn = $("#progressBtn");
  const greeting    = $("#greeting");
  const logoutBtn   = $("#logoutBtn");
  const breadcrumb  = $("#breadcrumb");
  const content     = $("#content");
  const searchInput = $("#searchInput");
  const studyTimeEl = $("#studyTime");
  const viewer      = $("#viewer");
  const viewerName  = $("#viewerName");
  const viewerClose = $("#viewerClose");
  const viewerOverlay = $("#viewerOverlay");
  const viewerPages = $("#viewerPages");
  const viewerThumbStrip = $("#viewerThumbStrip");
  const viewerThumbToggle = $("#viewerThumbToggle");
  const viewerPrevPage    = $("#viewerPrevPage");
  const viewerNextPage    = $("#viewerNextPage");
  const viewerPageInput   = $("#viewerPageInput");
  const viewerPageTotal   = $("#viewerPageTotal");
  const viewerFitWidth    = $("#viewerFitWidth");
  const viewerFitPage     = $("#viewerFitPage");
  const gatePasswordField = $("#gatePasswordField");
  const gatePasswordInput = $("#gatePasswordInput");
  const gateBtn     = $(".gate__btn");
  const gateError   = $("#gateError");
  const gateField   = $(".gate__field");
  const gateRequestApproval = $("#gateRequestApproval");
  const gateRequestBtn      = $("#gateRequestBtn");
  const gateRequestSent     = $("#gateRequestSent");

  // ── Admin dashboard refs ─────────────────────────────────
  const adminApp           = $("#adminApp");
  const adminBackBtn       = $("#adminBackBtn");
  const adminRefreshBtn    = $("#adminRefreshBtn");
  const adminPresenceList  = $("#adminPresenceList");
  const adminRosterList    = $("#adminRosterList");
  const adminDetail        = $("#adminDetail");
  const adminDetailOverlay = $("#adminDetailOverlay");
  const adminDetailClose   = $("#adminDetailClose");
  const adminDetailName    = $("#adminDetailName");
  const adminDetailBody    = $("#adminDetailBody");
  const adminApprovalList  = $("#adminApprovalList");
  const adminRejectedList  = $("#adminRejectedList");
  const adminAddNameInput  = $("#adminAddNameInput");
  const adminAddNameBtn    = $("#adminAddNameBtn");
  const adminApproveSelectedBtn = $("#adminApproveSelectedBtn");
  const adminRejectSelectedBtn  = $("#adminRejectSelectedBtn");
  const adminRosterSearch  = $("#adminRosterSearch");
  const adminMergeBtn      = $("#adminMergeBtn");
  const adminSuspendSelectedBtn = $("#adminSuspendSelectedBtn");
  const adminFlagsList     = $("#adminFlagsList");
  const adminAuditList     = $("#adminAuditList");
  const adminBroadcastBtn  = $("#adminBroadcastBtn");
  const adminExportBtn     = $("#adminExportBtn");
  const adminContentStatsList = $("#adminContentStatsList");
  const adminFeedbackAvg      = $("#adminFeedbackAvg");
  const adminFeedbackList     = $("#adminFeedbackList");
  const adminScanBtn          = $("#adminScanBtn");
  const adminScanProgress     = $("#adminScanProgress");
  const adminScanTimer        = $("#adminScanTimer");
  const adminScanResults      = $("#adminScanResults");
  const adminArchiveBtn    = $("#adminArchiveBtn");
  const adminBlockedDevicesList = $("#adminBlockedDevicesList");
  const adminTabs = $("#adminTabs");
  const adminSummaryStrip = $("#adminSummaryStrip");
  const toastStack = $("#toastStack");
  const confirmOverlay = $("#confirmOverlay");
  const confirmMessage = $("#confirmMessage");
  const confirmCancelBtn = $("#confirmCancelBtn");
  const confirmOkBtn = $("#confirmOkBtn");
  const confirmInput = $("#confirmInput");

  // ── State ──────────────────────────────────────────────
  let curView     = "home";
  let curSubject  = null;
  let curFolder   = null;
  let currentName = "";
  let adminApiToken = null; // set only after the passphrase gate succeeds — see hashAdminSecret usage above

  // ── Session / view tracking (for the activity log) ──────
  // sessionId identifies one "visit" (from the app becoming visible
  // to the tab closing/reloading/logging out). viewId identifies one
  // PDF being open. Both are randomly generated client-side purely to
  // let rows in the Log sheet be grouped back into a readable trail —
  // they carry no personal info themselves.
  let sessionId          = null;
  let sessionStart        = null;
  let currentViewId       = null;
  let currentViewName     = null;
  let currentViewActiveMs = 0;   // accumulated foreground time for the open PDF
  let currentViewResumedAt = null; // timestamp the PDF most recently became foregrounded
  let heartbeatTimer      = null;

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // ── Helpers ────────────────────────────────────────────
  // ── PDF access token (Apps Script → Cloudflare Worker) ──────────
  // PDFs are no longer fetched as static files from this repo. Every
  // open goes through the Worker, which only streams file bytes back
  // if it's handed a genuine, unexpired token — minted server-side by
  // Apps Script's getPdfToken action, which re-checks (fresh, live)
  // that this name is still on the access list and not suspended.
  // That's the actual security decision; this file just carries the
  // token along. Cached in memory and refreshed a few minutes before
  // its ~20-minute expiry so opening a PDF mid-session never has to
  // wait on a fresh token fetch.
  let pdfToken = null;
  let pdfTokenExpiresAt = 0;
  let pdfTokenPromise = null;

  // Throws instead of returning null on failure, carrying the SPECIFIC
  // reason as the error message ("suspended", "unauthorized", or one
  // of the three local codes below) instead of collapsing everything
  // into one generic failure. This is what lets openViewer's catch
  // handler show "you've been suspended" instead of "please try
  // again" to someone who's been blocked — the old version discarded
  // the server's actual reason and made every failure look like a
  // network blip, which is actively misleading for that case.
  async function fetchPdfToken() {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    const workerUrl = SITE_CONFIG.pdfWorker && SITE_CONFIG.pdfWorker.url;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) throw new Error("not_configured");
    if (!workerUrl || workerUrl.indexOf("PASTE_YOUR") === 0) throw new Error("not_configured");
    if (!sessionId || !currentName) throw new Error("not_logged_in");

    let data;
    try {
      const url = `${endpoint}?action=getPdfToken&name=${encodeURIComponent(currentName)}&sessionId=${encodeURIComponent(sessionId)}`;
      const res = await fetch(url);
      data = await res.json();
    } catch {
      throw new Error("network");
    }

    if (data && data.ok && data.token) {
      pdfToken = data.token;
      // Real token is good for 20 minutes (see mintPdfToken in the
      // Apps Script) — refresh a few minutes early so we're never
      // caught handing out a token that expires mid-fetch.
      pdfTokenExpiresAt = Date.now() + 17 * 60 * 1000;
      return pdfToken;
    }
    throw new Error((data && data.error) || "network");
  }

  // Returns a usable token, fetching a new one only if there's no
  // cached token or the cached one is due to expire soon. Concurrent
  // callers (e.g. several thumbnails loading at once) share a single
  // in-flight fetch instead of each firing their own request.
  function ensurePdfToken() {
    if (pdfToken && Date.now() < pdfTokenExpiresAt) return Promise.resolve(pdfToken);
    if (!pdfTokenPromise) {
      pdfTokenPromise = fetchPdfToken().finally(() => { pdfTokenPromise = null; });
    }
    return pdfTokenPromise;
  }

  function pdfWorkerUrl(path, token) {
    const base = SITE_CONFIG.pdfWorker.url;
    return `${base}?file=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`;
  }

  // Case/whitespace-insensitive match against the access list —
  // "PRIYA", " priya ", "Priya" all match "Priya".
  function normalizeName(s) {
    return s.trim().replace(/\s+/g, " ").toLowerCase();
  }

  // ── Abuse/harassment filter ──────────────────────────────
  // Best-effort, not exhaustive — extend these two lists if something
  // gets through. ABUSIVE_WHOLE_WORDS is matched only against whole
  // words (so it won't false-positive on a short substring buried
  // inside a real name); ABUSIVE_PHRASES is matched as a substring of
  // the full normalized string, for multi-word taunts.
  const ABUSIVE_WHOLE_WORDS = [
    "bsdk", "bsdka", "mc", "bc", "chutiya", "chutiye", "harami",
    "kutta", "kutte", "kamina", "kamine", "randi", "gandu", "gaandu",
    "bhosdi", "bhosdike", "saala", "saale",
    "fuck", "fucker", "bitch", "asshole", "bastard", "dumbass"
  ];
  const ABUSIVE_PHRASES = [
    "tera baap", "teri maa", "teri behen"
  ];

  // Deliberately NOT a call to an external moderation API — see the
  // reasoning in chat: that would add a network dependency, a cost,
  // and latency to every single login, legitimate or not, for a name
  // field. This instead defeats the cheap, common evasion tricks
  // (leetspeak, spacing/punctuation, stretched letters) with a plain
  // string transform, which covers the realistic threat model here.
  const LEET_MAP = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };
  function squash(str) {
    return normalizeName(str)
      .split("")
      .map((c) => LEET_MAP[c] || c)
      .join("")
      .replace(/[^a-z]/g, "")       // drop spaces/punctuation entirely
      .replace(/(.)\1{2,}/g, "$1"); // "bsdkkkk" -> "bsdk"
  }

  function looksAbusive(name) {
    const norm = normalizeName(name).replace(/[^a-z\s]/g, "");
    if (ABUSIVE_PHRASES.some((p) => norm.includes(p))) return true;
    const words = norm.split(/\s+/).filter(Boolean);
    if (words.some((w) => ABUSIVE_WHOLE_WORDS.includes(w))) return true;

    // Second pass: squash out spacing/leetspeak/letter-stretching and
    // check again. Restricted to words of 4+ letters — squashing
    // removes spaces entirely, and re-checking a 2-letter word like
    // "mc" as a bare substring would false-positive on ordinary names
    // ("Ram Chandra" -> "ramchandra" contains "mc"). Longer words don't
    // have that problem.
    const squashed = squash(name);
    return ABUSIVE_WHOLE_WORDS.filter((w) => w.length >= 4).some((w) => squashed.includes(squash(w)));
  }

  // The access list stores salted SHA-256 hashes, not plaintext names,
  // so that opening dev tools on config.js doesn't hand someone the
  // exact list of valid names to try. This is a deterrent against
  // casual snooping, not real security — see the comment in config.js.
  async function sha256Hex(str) {
    const bytes = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hashName(name) {
    const list = SITE_CONFIG.accessList;
    const salt = (list && list.salt) || "";
    return sha256Hex(salt + normalizeName(name));
  }

  // Verifies a protected-account password against the server, never
  // Sends only a hash of the password, salted with
  // SITE_CONFIG.protectedAccounts.salt — never the password itself.
  // Returns "valid", "invalid", or "error" (never a plain boolean)
  // so the caller can tell "the server said no" apart from "the
  // check never actually finished" — those are NOT the same thing,
  // and treating them the same was the actual bug behind "the first
  // attempt always says incorrect password, the second always
  // works": the very first check after this feature goes live has
  // to make the Apps Script side create a brand-new sheet from
  // scratch, which is genuinely slower than a quick timeout allows
  // for — so it silently timed out and got mislabeled as a wrong
  // password, when the real password was never actually checked.
  // One quiet retry with a longer timeout now happens automatically
  // before ever surfacing an error to the person typing.
  async function checkCredentialsRemote(username, password) {
    const cred = SITE_CONFIG.protectedAccounts;
    if (!cred) return "error";
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) return "error";
    const credHash = await sha256Hex(cred.salt + normalizeName(username) + "|" + password);
    const url = `${endpoint}?action=checkCredentials&username=${encodeURIComponent(username)}&credHash=${encodeURIComponent(credHash)}`;

    async function attempt(timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        const data = await res.json();
        if (!data || !data.ok) return "error"; // the request completed but the server itself reported a problem — not a verified "wrong password"
        return data.valid ? "valid" : "invalid";
      } catch {
        clearTimeout(timeout);
        return "error";
      }
    }

    const first = await attempt(10000); // generous — a cold Apps Script execution creating a sheet for the first time can genuinely take a few seconds
    if (first !== "error") return first;
    return attempt(10000); // one quiet retry before giving up; by now the server is almost always warm
  }

  async function isAuthorized(name) {
    const list = SITE_CONFIG.accessList;
    if (!list || !list.enabled) return true;
    if (!window.crypto || !window.crypto.subtle) return true; // insecure context (e.g. plain http) — fail open rather than lock everyone out
    const hash = await hashName(name);
    if (list.hashes.includes(hash)) return true;
    // Live-approved names — added from the admin dashboard's approval
    // queue or "Add name" box, no redeploy needed. Checked in addition
    // to the static list above, never instead of it.
    const remote = await fetchLoginCheck(name);
    return remote.accessHashes.includes(hash);
  }

  // ── Consolidated remote login check ──────────────────────────────
  // One request, cached for the rest of this page load, covering
  // everything isSuspended/isAuthorized/isNameActive need from the
  // server: the live device blocklist, live access list, live+expired
  // suspended-name list, and whether this name is active elsewhere
  // right now. This used to be 4 separate sequential fetches — each
  // its own Apps Script cold-start — adding real, noticeable seconds
  // to every login on a slow connection. Same data, same checks, just
  // fetched together. Fails open (empty/false) on any network error,
  // same philosophy as everything else here: a hiccup reaching the
  // sheet should never lock out someone who's actually fine.
  let cachedLoginCheck = null;
  async function fetchLoginCheck(name) {
    if (cachedLoginCheck) return cachedLoginCheck;
    const fallback = { blockedDeviceIds: [], accessHashes: [], suspendedHashes: [], active: false };
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) return fallback;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${endpoint}?action=loginCheck&name=${encodeURIComponent(name || "")}`, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      cachedLoginCheck = (data && data.ok) ? {
        blockedDeviceIds: data.blockedDeviceIds || [],
        accessHashes: data.accessHashes || [],
        suspendedHashes: data.suspendedHashes || [],
        active: !!data.active
      } : fallback;
    } catch {
      cachedLoginCheck = fallback;
    }
    return cachedLoginCheck;
  }

  // Console helper for adding a new student later without re-editing
  // through an AI assistant: open dev tools on the live site and run
  //   await __hashName("Their Name")
  // then paste the printed hash into config.js's accessList.hashes.
  window.__hashName = async (name) => {
    const hash = await hashName(name);
    console.log(hash);
    return hash;
  };

  // Admin secret hashing — same salted-hash model as hashName above,
  // but NOT lowercased/space-collapsed, so case and spacing in your
  // chosen phrase count toward its strength instead of being thrown
  // away. Console helper: open dev tools on the live site and run
  //   await __hashAdminSecret("your chosen phrase")
  // then paste the printed value into config.js's admin.secretHash.
  async function hashAdminSecret(secret) {
    const salt = (SITE_CONFIG.admin && SITE_CONFIG.admin.salt) || "";
    return sha256Hex(salt + secret.trim());
  }

  window.__hashAdminSecret = async (secret) => {
    const hash = await hashAdminSecret(secret);
    console.log(hash);
    return hash;
  };

  // ── Device fingerprint ──────────────────────────────────
  // A hash of stable browser/hardware signals — NOT tied to any name
  // typed into the gate. This is what lets us block a specific phone
  // even if it enters someone else's name.
  //
  // The canvas-rendering signal that used to be part of this was
  // REMOVED after testing showed it changing across a fully-closed-
  // and-reopened browser on the exact same phone — which meant a
  // banned device could get a fresh ID just by force-closing the app
  // and relaunching the link. That's not a bug in this code: recent
  // Chrome (and most in-app browsers, WhatsApp's included) now inject
  // small random noise into canvas readback specifically to defeat
  // canvas fingerprinting — it's a deliberate anti-tracking feature,
  // and it resets that noise on a fresh session. There's no reliable
  // way to read a "clean" canvas value around it from JavaScript.
  //
  // What's left below is every OTHER signal — none of them are
  // subject to that noise, so they should now be stable across
  // reopens on the same phone. Trade-off worth knowing: this makes
  // the fingerprint a little less unique between two totally
  // different phones that happen to share the exact same model,
  // browser version, screen size, language, and timezone — an edge
  // case, but not impossible. There's no purely-client-side way to
  // fully close that gap; a hard guarantee would need device
  // attestation from a native app or phone-number verification,
  // neither of which fits a static site like this one.
  let cachedDeviceId = null;
  async function getDeviceId() {
    if (cachedDeviceId) return cachedDeviceId;
    const parts = [
      navigator.userAgent || "",
      navigator.platform || "",
      navigator.language || "",
      String(navigator.hardwareConcurrency || ""),
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      (Intl.DateTimeFormat().resolvedOptions().timeZone || "")
    ];
    cachedDeviceId = await sha256Hex(parts.join("||"));
    return cachedDeviceId;
  }

  // A human-readable guess at what device this is, purely for admin
  // display next to the (opaque) device hash above — never used for
  // matching/blocking itself. Best-effort, not exact:
  //   - Android UAs often include the real model string (e.g.
  //     "SM-G991B") right after the Android version — this shows up
  //     when it's there.
  //   - iPhones/iPads will only ever show as "iPhone"/"iPad" plus an
  //     iOS version. Apple deliberately strips the exact model from
  //     the user-agent string for privacy — there's no way to get a
  //     more specific label than that from the browser.
  //   - Desktop OSes and common browsers are detected from simple
  //     substring checks, same limitation: whatever the UA reveals.
  function parseDeviceLabel() {
    const ua = navigator.userAgent || "";
    let platform = "Unknown device";

    const androidMatch = ua.match(/Android\s+([\d.]+);\s*([^;)]+)\)/);
    if (androidMatch) {
      platform = `Android ${androidMatch[1]} \u00B7 ${androidMatch[2].trim()}`;
    } else if (/iPhone/.test(ua)) {
      const v = ua.match(/OS (\d+)/);
      platform = `iPhone \u00B7 iOS ${v ? v[1] : "?"}`;
    } else if (/iPad/.test(ua)) {
      const v = ua.match(/OS (\d+)/);
      platform = `iPad \u00B7 iPadOS ${v ? v[1] : "?"}`;
    } else if (/Windows/.test(ua)) {
      platform = "Windows";
    } else if (/Macintosh/.test(ua)) {
      platform = "Mac";
    } else if (/Linux/.test(ua)) {
      platform = "Linux";
    }

    let browser = "";
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/CriOS/.test(ua)) browser = "Chrome";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Safari\//.test(ua)) browser = "Safari";

    // Strip characters that would break the " || key:value" trace
    // format this gets embedded into (see the trace string below).
    const label = browser ? `${platform} \u00B7 ${browser}` : platform;
    return label.replace(/[|:]/g, "").trim();
  }

  // Console helper: open dev tools on the suspect's phone (or ask them
  // to, or just check the log sheet after their next attempt — see
  // logEvent below, which now records this on every login try) and
  // run  await __deviceId()  to get the value to paste into
  // config.js's suspended.deviceIds.
  window.__deviceId = async () => {
    const id = await getDeviceId();
    console.log(id);
    return id;
  };

  // ── Client IP (best-effort, bonus layer only) ───────────
  // Fetched from a public "what's my IP" service since a static site
  // has no server of its own to read it from. Fails silently (empty
  // string) if the request is blocked or slow — never blocks login on
  // a network hiccup.
  let cachedIp = null;
  async function getClientIp() {
    if (cachedIp !== null) return cachedIp;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      cachedIp = data.ip || "";
    } catch {
      cachedIp = "";
    }
    return cachedIp;
  }

  // ── Suspension check ─────────────────────────────────────
  // Checked BEFORE the normal accessList lookup. Any one of four
  // signals is enough to block: the typed name, this browser's device
  // fingerprint (checked against BOTH the static config.js list and
  // the auto-maintained remote list), or (best-effort) the current IP.
  // This is what makes "enters a classmate's name instead" not work —
  // the device fingerprint check doesn't care what name was typed.
  async function isSuspended(name) {
    const s = SITE_CONFIG.suspended;
    if (!s || !s.enabled) return false;

    if (name && Array.isArray(s.hashes) && s.hashes.length) {
      const hash = await hashName(name);
      if (s.hashes.includes(hash)) return true;
    }

    const deviceId = await getDeviceId();

    if (Array.isArray(s.deviceIds) && s.deviceIds.includes(deviceId)) return true;

    const remote = await fetchLoginCheck(name);
    if (remote.blockedDeviceIds.includes(deviceId)) return true;

    // Live-suspended names — added from the admin dashboard's Suspend
    // button, which also cascades to every linked alias and device.
    // Checked in addition to the static config.js list above.
    if (name) {
      const hash = await hashName(name);
      if (remote.suspendedHashes.includes(hash)) return true;
    }

    if (Array.isArray(s.ips) && s.ips.length) {
      const ip = await getClientIp();
      if (ip && s.ips.includes(ip)) return true;
    }

    return false;
  }

  // ── Font-load gate ───────────────────────────────────────
  // The gate's entrance animation is written in CSS as "paused"
  // until this fires. Fraunces/Archivo load async — if the reveal
  // ran on the browser's fallback-font layout, the real webfont
  // swapping in partway through would reflow the title (one line
  // → two lines) mid-clip-path and freeze the animation on a cut
  // frame. Waiting for the real fonts first removes that failure
  // mode entirely. A hard timeout guarantees the page never stays
  // invisible if font loading stalls (slow network, blocked CDN).
  function markFontsReady() {
    document.documentElement.classList.add("fonts-ready");
  }

  if (document.fonts && document.fonts.ready) {
    Promise.race([
      Promise.all([
        document.fonts.load('italic 500 100px Fraunces'),
        document.fonts.load('500 15px Archivo'),
        document.fonts.load('600 15px Archivo'),
        document.fonts.ready
      ]),
      new Promise((resolve) => setTimeout(resolve, 900))
    ]).then(markFontsReady).catch(markFontsReady);
  } else {
    setTimeout(markFontsReady, 300);
  }

  // ── Session persistence ──────────────────────────────────
  //  sessionStorage, not localStorage: localStorage is shared by
  //  every tab/WebView instance for this domain — including a brand
  //  new one Chrome/Safari spins up the next time someone taps the
  //  same WhatsApp link. That's what made a second tap silently
  //  resume the previous person's login instead of asking fresh.
  //  sessionStorage is scoped to that one tab/instance and is wiped
  //  the moment it's actually closed, so a fresh tap always starts
  //  with nothing stored — while still keeping someone logged in
  //  normally while they navigate around inside the same open tab.
  //  Stored as JSON {name, ts} rather than a bare name, so we can
  //  also expire it after SITE_CONFIG.session.expiryMinutes if that
  //  same tab is just left open and idle for a long stretch.
  function saveSession(name, sid) {
    sessionStorage.setItem("c12_name", JSON.stringify({ name, ts: Date.now(), sid }));
  }

  // Reads back the sessionId saved alongside the name, so a plain page
  // reload (init() calling showApp(saved) directly, not a fresh
  // login) reuses the SAME sessionId instead of minting a new one —
  // otherwise every reload would look like "a different device just
  // logged in" to claimActiveSession below, harmlessly but wastefully
  // kicking out its own just-abandoned previous instance each time.
  function readSessionId() {
    const raw = sessionStorage.getItem("c12_name");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return (parsed && parsed.sid) || null;
    } catch {
      return null;
    }
  }

  function readSession() {
    const raw = sessionStorage.getItem("c12_name");
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Old format from before expiry was added: a bare name string.
      // Treat it as expired so everyone gets re-prompted once, cleanly.
      return null;
    }
    if (!parsed || !parsed.name || !parsed.ts) return null;

    const minutes = (SITE_CONFIG.session && SITE_CONFIG.session.expiryMinutes);
    const maxAgeMs = (typeof minutes === "number" ? minutes : 15) * 60 * 1000;
    if (Date.now() - parsed.ts > maxAgeMs) return null; // expired

    return parsed.name;
  }

  function clearSession() {
    sessionStorage.removeItem("c12_name");
  }

  // Shared by the manual "sign out" button and a forced admin logout
  // (see checkCommands below) — same clean-up either way: end any
  // open PDF view, log the session as ended, stop the heartbeat, wipe
  // the saved name, then reload back to the gate.
  function performLogout(reason) {
    endCurrentView();
    if (sessionId) {
      const seconds = sessionStart ? Math.round((Date.now() - sessionStart) / 1000) : "";
      logEventBeacon("session_end", currentName, reason || "logout", undefined, { duration: seconds });
    }
    stopHeartbeat();
    clearSession();
    location.reload();
  }

  // ── Init ───────────────────────────────────────────────
  async function init() {
    const saved = readSession();
    if (saved && (await isSuspended(saved))) {
      clearSession();
      gate.classList.remove("hidden");
      app.classList.add("hidden");
      showGateError((SITE_CONFIG.suspended && SITE_CONFIG.suspended.message) || "You are not able to access this page.");
    } else if (saved && (await isAuthorized(saved))) {
      gate.classList.add("hidden");
      showApp(saved);
    } else {
      if (saved) clearSession(); // no longer on the list, or expired
      gate.classList.remove("hidden");
      app.classList.add("hidden");
    }

    nameForm.addEventListener("submit", onNameSubmit);
    nameInput.addEventListener("input", hideGateError);
    if (gateRequestBtn) {
      gateRequestBtn.addEventListener("click", () => {
        if (!pendingApprovalName || gateRequestBtn.disabled) return;
        gateRequestBtn.disabled = true;
        gateRequestBtn.classList.add("is-busy");
        gateRequestBtn.textContent = "Sending…";
        // Tagged distinctly from the plain "unauthorized" attempts
        // logged automatically on every failed try — the backend's
        // approval queue reads from THIS tag only, not from every
        // login attempt. See getUnauthorizedQueue in the Apps Script.
        logEvent("login", pendingApprovalName, "approval_requested", pendingApprovalTrace);
        gateRequestBtn.classList.add("hidden");
        if (gateRequestSent) gateRequestSent.classList.remove("hidden");
        pendingApprovalName = null;
        pendingApprovalTrace = null;
      });
    }
    // Safety net for mobile keyboards: some virtual keyboards' Enter/Go
    // key doesn't reliably fire a native form submit inside in-app
    // browsers. Preventing the default here and calling requestSubmit()
    // ourselves makes Enter behave exactly like tapping Continue, on
    // every browser, without ever double-submitting.
    nameInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (nameForm.requestSubmit) nameForm.requestSubmit();
      else onNameSubmit(e);
    });
    homeBtn.addEventListener("click", () => nav("home"));
    if (progressBtn) progressBtn.addEventListener("click", () => nav("progress"));
    logoutBtn.addEventListener("click", () => {
      // No confirmation here at all was the actual bug behind "logs
      // out suddenly if something is clicked" — this button sits
      // packed in a row with five other small icons (WhatsApp, email,
      // progress, search), and a mis-tap on it ended the session
      // instantly with zero warning. checkCommands' forceLogout path
      // was the other suspect, but that one's already correctly
      // gated (exact session match, consumed the instant it's read,
      // requires an explicit tap to confirm) — this button genuinely
      // had none of that.
      if (confirm("Sign out of Class 12?")) performLogout("logout");
    });

    // ── Support Us (UPI) ────────────────────────────────────
    // No amount is pre-filled — the "am" param is deliberately left
    // out of the UPI URI so whoever pays picks the amount themselves.
    // The upi:// link only does anything where a UPI app can handle
    // it (Android mainly); the QR code underneath is what makes it
    // actually usable from a laptop, or an iPhone (iOS has no
    // system-level UPI handler) — scan it with any UPI app on a
    // phone instead. The QR image itself is generated by a small
    // free public API (api.qrserver.com) — the one external
    // dependency here; everything else about the site stays
    // self-contained.
    const supportBtn = $("#supportBtn");
    const supportModal = $("#supportModal");
    if (supportBtn && supportModal) {
      const upiUri = "upi://pay?pa=7405806352@fam&pn=Adnan&cu=INR";
      const upiLink = $("#supportUpiLink");
      const qrImg = $("#supportQr");
      const openSupportModal = () => {
        if (upiLink) upiLink.href = upiUri;
        if (qrImg && !qrImg.src) {
          qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(upiUri)}`;
        }
        supportModal.classList.remove("hidden");
      };
      const closeSupportModal = () => supportModal.classList.add("hidden");
      supportBtn.addEventListener("click", openSupportModal);
      $("#supportModalClose").addEventListener("click", closeSupportModal);
      $("#supportModalOverlay").addEventListener("click", closeSupportModal);
    }
    if (searchInput) searchInput.addEventListener("input", () => render());
    document.addEventListener("visibilitychange", () => {
      if (!currentViewId) return;
      if (document.hidden) {
        if (currentViewResumedAt !== null) {
          currentViewActiveMs += Date.now() - currentViewResumedAt;
          currentViewResumedAt = null;
        }
      } else {
        currentViewResumedAt = Date.now();
      }
    });

    // Fires on tab close, browser close, and reload — the one moment
    // a normal fetch can't be trusted to finish, so both of these go
    // out via sendBeacon instead (see logEventBeacon above).
    window.addEventListener("pagehide", () => {
      endCurrentView();
      if (sessionId) {
        const seconds = sessionStart ? Math.round((Date.now() - sessionStart) / 1000) : "";
        logEventBeacon("session_end", currentName, "closed", undefined, { duration: seconds });
      }
    });

    adminBackBtn.addEventListener("click", exitAdmin);
    adminRefreshBtn.addEventListener("click", refreshAdmin);
    adminAddNameBtn.addEventListener("click", onAdminAddName);
    adminAddNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onAdminAddName(); });
    adminRosterSearch.addEventListener("input", () => renderAdminRoster(true));
    adminMergeBtn.addEventListener("click", onMergeSelected);
    adminApproveSelectedBtn.addEventListener("click", onApproveSelected);
    adminRejectSelectedBtn.addEventListener("click", onRejectSelected);
    adminSuspendSelectedBtn.addEventListener("click", onSuspendSelected);
    adminBroadcastBtn.addEventListener("click", onBroadcastMessage);
    adminExportBtn.addEventListener("click", onExportCsv);
    adminArchiveBtn.addEventListener("click", onArchiveOldLogs);
    adminScanBtn.addEventListener("click", onScanBackblaze);
    adminTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".admin__tab");
      if (btn) switchAdminTab(btn.dataset.tab);
    });
    adminDetailClose.addEventListener("click", closeAdminDetail);
    adminDetailOverlay.addEventListener("click", closeAdminDetail);

    viewerClose.addEventListener("click", closeViewer);
    viewerThumbToggle.addEventListener("click", () => {
      viewerThumbStrip.classList.toggle("viewer__thumb-strip--open");
    });
    viewerOverlay.addEventListener("click", closeViewer);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncViewerViewport);
      window.visualViewport.addEventListener("scroll", syncViewerViewport);
    }
    $("#viewerZoomIn").addEventListener("click", zoomIn);
    $("#viewerZoomOut").addEventListener("click", zoomOut);
    if (viewerPrevPage) viewerPrevPage.addEventListener("click", prevPage);
    if (viewerNextPage) viewerNextPage.addEventListener("click", nextPage);
    if (viewerPageInput) {
      viewerPageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const p = parseInt(viewerPageInput.value, 10);
          if (!isNaN(p)) scrollToPage(p);
          viewerPageInput.blur();
        }
      });
      viewerPageInput.addEventListener("change", () => {
        const p = parseInt(viewerPageInput.value, 10);
        if (!isNaN(p)) scrollToPage(p);
      });
      viewerPageInput.addEventListener("blur", () => {
        const p = parseInt(viewerPageInput.value, 10);
        if (isNaN(p) || (currentPdf && (p < 1 || p > currentPdf.numPages))) {
          if (pagesInner) {
            const wraps = pagesInner.querySelectorAll(".viewer__page-wrap");
            const targetMid = viewerPages.scrollTop + viewerPages.clientHeight / 3;
            let closest = 1;
            let minDiff = Infinity;
            wraps.forEach((w) => {
              const diff = Math.abs(w.offsetTop - targetMid);
              if (diff < minDiff) { minDiff = diff; closest = Number(w.dataset.pageNum); }
            });
            viewerPageInput.value = closest;
          }
        }
      });
    }
    window.addEventListener("resize", () => {
      if (!viewer.classList.contains("hidden")) syncViewerViewport();
    });
    if (viewerFitWidth) viewerFitWidth.addEventListener("click", fitToWidth);
    if (viewerFitPage) viewerFitPage.addEventListener("click", fitToPage);
    viewerPages.addEventListener("scroll", onViewerScroll, { passive: true });
    viewerPages.addEventListener("touchstart", onViewerTouchStart, { passive: true });
    viewerPages.addEventListener("touchmove", onViewerTouchMove, { passive: false });
    viewerPages.addEventListener("touchend", onViewerTouchEnd, { passive: true });
    viewerPages.addEventListener("touchcancel", onViewerTouchEnd, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeViewer();

      // Keyboard navigation for PDF viewer (PageUp/PageDown)
      if (!viewer.classList.contains("hidden")) {
        if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
          if (e.key === "PageDown" || (e.key === "ArrowDown" && e.altKey)) {
            e.preventDefault();
            nextPage();
          } else if (e.key === "PageUp" || (e.key === "ArrowUp" && e.altKey)) {
            e.preventDefault();
            prevPage();
          }
        }
      }

      // Block the obvious save/print shortcuts while a PDF is open.
      // This deters casual attempts, not determined ones — anyone
      // using DevTools directly can still get around it, same as any
      // browser-rendered PDF viewer (Google Drive's included).
      if (!viewer.classList.contains("hidden") && (e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "p")) {
        e.preventDefault();
      }
    });
    viewerPages.addEventListener("contextmenu", (e) => e.preventDefault());

    // Subtle magnetic pull on the gate CTA — a single deliberate
    // hover moment, not applied anywhere else.
    if (gateBtn && matchMedia("(hover: hover)").matches) {
      gateBtn.addEventListener("mousemove", (e) => {
        const r = gateBtn.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) * 0.15;
        const y = (e.clientY - r.top - r.height / 2) * 0.3;
        gateBtn.style.transform = `translate(${x}px, ${y}px)`;
      });
      gateBtn.addEventListener("mouseleave", () => {
        gateBtn.style.transform = "";
      });
    }
  }

  // ── Name Gate ──────────────────────────────────────────
  async function onNameSubmit(e) {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;

    // Instant feedback the moment Continue is tapped/clicked — before
    // any of the network-bound checks below even start. Those checks
    // (device/IP lookups) can take a second or two on a slow
    // connection, and with no visual change on tap it looked like the
    // press hadn't registered, so people tapped again (or gave up).
    setGateBusy(true);
    hideGateError();

    try {
      // Admin entry: checked before anything else, and returns early
      // so this never touches the Log sheet, the access list, or
      // localStorage — the admin secret leaves no trace of itself in
      // your own student-facing data. Compared as a salted hash, same
      // model as the access list, so the real phrase never sits in
      // config.js as plain text.
      if (SITE_CONFIG.admin && SITE_CONFIG.admin.enabled && SITE_CONFIG.admin.secretHash) {
        const candidateHash = await hashAdminSecret(name);
        if (candidateHash === SITE_CONFIG.admin.secretHash) {
          // The hash IS the API token from here on — nothing else is
          // needed. This used to be a separate plaintext admin.key
          // sitting in config.js, which is a publicly downloadable
          // file: anyone opening dev tools could read it straight off
          // and call every admin endpoint themselves, no passphrase
          // needed. Reusing candidateHash instead means the only
          // secret that ever exists is the passphrase itself, which
          // never touches any file — exactly the same guarantee the
          // access list and suspended list already rely on.
          adminApiToken = candidateHash;
          nameInput.value = "";
          hideGateError();
          enterAdmin();
          return;
        }
      }

      // Protected accounts (name + password) — checked before the
      // normal abuse/suspended/authorized flow below, since this is a
      // fundamentally different kind of login. A correct password
      // substitutes for the normal "on the approved list" check
      // further down (that's the whole point of a password), but
      // NOT for the suspended check — even a password holder can
      // still be suspended if something goes wrong.
      const normalizedEntry = normalizeName(name);
      const protectedList = (SITE_CONFIG.protectedAccounts && SITE_CONFIG.protectedAccounts.usernames) || [];
      let credentialsVerified = false;
      if (protectedList.includes(normalizedEntry)) {
        const password = gatePasswordInput.value;
        if (!password) {
          gatePasswordField.classList.remove("hidden");
          gatePasswordInput.focus();
          setGateBusy(false);
          return;
        }
        const result = await checkCredentialsRemote(name, password);
        if (result === "invalid") {
          showGateError("Incorrect password.");
          gatePasswordInput.value = "";
          gatePasswordInput.focus();
          return;
        }
        if (result === "error") {
          // The check itself couldn't complete (even after the
          // built-in retry) — genuinely different from a wrong
          // password, so it gets an honest message instead, and the
          // password is deliberately NOT cleared: whatever they typed
          // was never actually verified either way, so there's no
          // reason to make them retype it.
          showGateError("Couldn't verify your password — check your connection and try again.");
          return;
        }
        credentialsVerified = true;
      } else if (!gatePasswordField.classList.contains("hidden")) {
        // They'd triggered the password field for an earlier name,
        // then changed the name field to something that isn't
        // protected — clear it out so it doesn't linger irrelevantly.
        gatePasswordField.classList.add("hidden");
        gatePasswordInput.value = "";
      }

      // Tagged distinctly as "suspended" (not folded into "unauthorized")
      // so the Apps Script backend can tell this specific case apart and
      // auto-add the device fingerprint (parsed out of the page field
      // below) to its own blocklist — see the backend's doPost. This
      // needs the fresh Apps Script deployment to understand the tag;
      // it's safe now since that's being redeployed anyway.
      //
      // All three network-bound lookups fire together instead of one
      // after another, AND the remote lookup itself is now a single
      // consolidated call (fetchLoginCheck) instead of 4 separate
      // ones — see its comment above. Prefetching it here means
      // isSuspended()/isAuthorized()/isNameActive() below just read
      // the already-resolved, cached result instead of each firing
      // their own request.
      const [deviceId, ip] = await Promise.all([
        getDeviceId(),
        getClientIp(),
        fetchLoginCheck(name)
      ]);
      const trace = `${location.href} || device:${deviceId} || ip:${ip || "unknown"} || label:${parseDeviceLabel()}`;

      // Harassment/abuse in the name field itself (e.g. someone typing
      // slurs or taunts instead of a real name) gets the device
      // auto-blocked outright — tagged "abusive" so the backend's
      // doPost treats it exactly like a suspended-name login: the
      // device fingerprint goes straight into BlockedDevices, no
      // admin action needed. This is a best-effort word/phrase list
      // (see ABUSIVE_WHOLE_WORDS/ABUSIVE_PHRASES below), not a
      // guarantee — extend the lists if something gets through, and
      // the manual Suspend button in admin still works independently
      // of this for anything the filter misses.
      if (looksAbusive(name)) {
        logEvent("login", name, "abusive", trace);
        showGateError("You're not authorized to view this page. Please enter your actual name.");
        return;
      }

      if (await isSuspended(name)) {
        logEvent("login", name, "suspended", trace);
        showGateError((SITE_CONFIG.suspended && SITE_CONFIG.suspended.message) || "You are not able to access this page.");
        return;
      }

      if (!credentialsVerified && !(await isAuthorized(name))) {
        logEvent("login", name, "unauthorized", trace);
        // Framed as "not yet approved" rather than a flat rejection —
        // this used to read like a locked door ("you're not
        // authorized"), which doesn't fit a free, word-of-mouth
        // resource where you WANT people to ask for access. The
        // in-form button below is now the actual way to request it —
        // WhatsApp/Email further down the page still work too, for
        // anyone who'd rather message directly.
        showGateError("You're not authorized to view this page yet.");
        showGateApprovalOption(name, trace);
        return;
      }

      // One active session per identity at a time — now handled by
      // kicking the OLDER device out (see claimActiveSession, called
      // from showApp right after this) instead of blocking the NEW
      // login attempt the way this used to. The old approach also had
      // a real annoyance built in: your own reload or reopened tab
      // could trip it and lock YOU out for up to ~90 seconds. Letting
      // the new login through and force-logging-out the old session
      // is both what was actually asked for and doesn't have that
      // failure mode.

      hideGateError();
      const sid = makeId();
      saveSession(name, sid);
      logEvent("login", name, "authorized", trace);
      gatePasswordField.classList.add("hidden");
      gatePasswordInput.value = "";
      gate.classList.add("fade-out");
      setTimeout(() => { gate.classList.add("hidden"); showApp(name); }, 650);
    } finally {
      // Always release the busy state — on a rejected path the person
      // needs the button back immediately to retry; on the success
      // path it's harmless since the gate is already fading out.
      setGateBusy(false);
    }
  }

  // Instant visual proof that the tap/click registered, before any of
  // the network checks above resolve: button dims, label swaps, and
  // the arrow spins in place instead of nothing appearing to happen
  // for a couple of seconds.
  const gateBtnLabel = gateBtn.querySelector(".gate__btn-label");
  const gateBtnLabelText = gateBtnLabel ? gateBtnLabel.textContent : "";
  function setGateBusy(isBusy) {
    gateBtn.disabled = isBusy;
    gateBtn.classList.toggle("is-busy", isBusy);
    if (gateBtnLabel) gateBtnLabel.textContent = isBusy ? "Please wait…" : gateBtnLabelText;
  }

  function showGateError(msg) {
    gateError.textContent = msg;
    gateError.classList.remove("hidden");
    gateField.classList.remove("shake");
    // Force reflow so the shake animation can re-trigger on repeat attempts
    void gateField.offsetWidth;
    gateField.classList.add("shake");
  }

  function hideGateError() {
    gateError.classList.add("hidden");
    hideGateApprovalOption(); // the two are always shown/cleared together — see showGateApprovalOption's comment
  }

  // Holds whatever name+trace the "Send my name for approval" button
  // should submit if tapped right now — set only when the unauthorized
  // branch below actually shows the button, so a click can never fire
  // for a stale name from an earlier attempt.
  let pendingApprovalName = null;
  let pendingApprovalTrace = null;

  // Reveals the explicit "Send my name for approval" button — this is
  // the ONLY path that adds someone to the admin's approval queue.
  // Previously, the backend's pending-queue was built from every
  // single "unauthorized" login attempt automatically — meaning a
  // mistyped name, a curious stranger, or someone just poking at the
  // login screen all cluttered the admin dashboard identically to a
  // genuine request. Logging "unauthorized" (a couple of lines above
  // each call site below) still happens every time, for the audit-log
  // attempt counts — this button is the one thing that actually
  // surfaces a person to the admin, and only once they've deliberately
  // asked to be.
  function showGateApprovalOption(name, trace) {
    if (!gateRequestApproval) return;
    pendingApprovalName = name;
    pendingApprovalTrace = trace;
    gateRequestApproval.classList.remove("hidden");
    if (gateRequestBtn) {
      gateRequestBtn.classList.remove("hidden", "is-busy");
      gateRequestBtn.disabled = false;
      gateRequestBtn.textContent = "Send my name for approval";
    }
    if (gateRequestSent) gateRequestSent.classList.add("hidden");
  }

  function hideGateApprovalOption() {
    pendingApprovalName = null;
    pendingApprovalTrace = null;
    if (gateRequestApproval) gateRequestApproval.classList.add("hidden");
  }

  // Fetches the live file catalog and slots it into
  // SITE_CONFIG.subjects[i].subfolders in place of whatever's
  // hardcoded there — this is what lets a file added via the admin
  // dashboard's "Scan Backblaze" feature show up without a GitHub
  // edit. If the catalog sheet has nothing for a subject yet (a
  // brand-new deployment before the first scan-and-confirm ever
  // runs, or a network hiccup), that subject's hardcoded config.js
  // list is left untouched as a safety net rather than wiped to empty.
  // Called from showApp() without being awaited — see the comment
  // there — so this runs in the background after the home screen is
  // already visible, and showApp() just calls render() again once
  // this settles, to pick up anything new.
  async function fetchAndApplyCatalog() {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${endpoint}?action=catalog`, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      if (!data || !data.ok || !data.catalog) return;
      SITE_CONFIG.subjects.forEach((s) => {
        const liveSubfolders = data.catalog[s.id];
        if (liveSubfolders && liveSubfolders.length) s.subfolders = liveSubfolders;
      });
    } catch {
      // network hiccup — config.js's existing hardcoded list stands in as-is, site still works
    }
  }

  async function showApp(name) {
    currentName = name;
    sessionId = readSessionId() || makeId(); // reuses the one saved at login — a plain reload must NOT look like a different device logging in, or claimActiveSession below would kick out its own just-abandoned previous instance every single time
    sessionStart = Date.now();
    app.classList.remove("hidden");
    greeting.textContent = `Hi, ${name}`;
    logEvent("session_start", name, "");
    startHeartbeat();
    claimActiveSession(name); // fire-and-forget — see its own comment below for why this can't slow anything down
    ensurePdfToken(); // kick off in the background — don't make the very first thumbnail wait on it
    // Render immediately from config.js's own static subject list —
    // that's already everything needed for the home screen, zero
    // network calls. fetchAndApplyCatalog() used to be awaited RIGHT
    // HERE, meaning the entire home screen (every subject icon) sat
    // blank until a Google Apps Script round-trip finished — that
    // round-trip is genuinely a few seconds on Apps Script's own cold
    // start, which is exactly the "5-7 seconds before icons appear"
    // delay. The catalog only ever ADDS newly-scanned files on top of
    // the static list (see fetchAndApplyCatalog's own comment) — it's
    // an enhancement, not something the first paint should ever wait
    // on. Now it runs in the background and just redraws whatever's
    // currently on screen if it actually changed anything.
    nav("home");
    fetchAndApplyCatalog().then(() => render());
  }

  // ── Heartbeat ("who's on the site right now") ───────────
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, 45000);
    sendHeartbeat(); // so Presence shows them immediately, not after 45s
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function sendHeartbeat() {
    if (!sessionId) return;
    const where = currentViewId
      ? `viewing: ${currentViewName}`
      : (curFolder ? curFolder.name : curSubject ? curSubject.name : "home");
    logEvent("heartbeat", currentName, where);
    checkCommands();
    refreshStudyTime();
  }

  // Refetches "studied Xm today" and updates the nav display. Called
  // once right after login and then again on every heartbeat (~45s),
  // so it stays current through a session without hammering the
  // backend on every page interaction. Scoped by sessionId server-
  // side (see getTodayStatsForSession) — nothing here can be used to
  // read anyone else's study time.
  async function refreshStudyTime() {
    if (!sessionId || !studyTimeEl) return;
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${endpoint}?action=todayStats&sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      if (data && data.ok) {
        const mins = Math.round(data.todaySeconds / 60);
        studyTimeEl.textContent = mins > 0 ? `Studied ${mins}m today` : "";
      }
    } catch {
      // silent — this is a nice-to-have, not worth surfacing an error for
    }
  }

  // Heartbeats go out via a no-cors POST (see logEvent above), which
  // means the response body is opaque and unreadable — so an admin
  // message or forced logout can't ride along on that request. This
  // is a separate, plain GET instead (readable, same pattern as
  // adminFetch below) asking "anything waiting for my sessionId?".
  // Not gated behind admin.enabled — every student's browser needs to
  // be able to poll this, admin or not.
  // One-active-device-per-person. Fired once from showApp right after
  // login, never awaited and never on the critical path — if it's
  // slow or fails outright, login and the home screen are completely
  // unaffected either way, same fire-and-forget spirit as logEvent.
  // The actual kick-out isn't instant: the OTHER device only finds
  // out on its next heartbeat poll (every 45s, same as the admin's
  // manual force-logout already had) — going faster than that would
  // mean polling far more often just for this, which trades away the
  // "still very fast" you asked to keep. Up to ~45s where both
  // devices could technically still be in, then the older one is cut.
  function claimActiveSession(name) {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0 || !sessionId) return;
    try {
      const url = new URL(endpoint);
      url.searchParams.set("action", "claimSession");
      url.searchParams.set("name", name);
      url.searchParams.set("sessionId", sessionId);
      fetch(url.toString()).catch(() => {});
    } catch {
      // Never let this block login.
    }
  }

  async function checkCommands() {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0 || !sessionId) return;
    try {
      const url = new URL(endpoint);
      url.searchParams.set("action", "checkCommands");
      url.searchParams.set("sessionId", sessionId);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!data || !data.ok) return;
      if (data.forceLogout) {
        showAdminNotice(
          "You've been signed out by the admin.",
          () => performLogout("admin_logout")
        );
        return;
      }
      if (data.message) {
        showAdminNotice(data.message);
      }
    } catch {
      // Silent — same fire-and-forget spirit as the rest of logging.
      // A missed poll just means the message/logout arrives on the
      // next heartbeat instead.
    }
  }

  // Minimal popup for an admin-sent message (or the "you've been
  // logged out" notice). Built on demand rather than living in
  // index.html permanently, since it's rare enough not to need its
  // own static markup cluttering the page.
  function showAdminNotice(text, onClose) {
    const existing = $("#adminNotice");
    if (existing) existing.remove();

    const wrap = el("div", "admin-notice");
    wrap.id = "adminNotice";
    wrap.innerHTML = `
      <div class="admin-notice__overlay"></div>
      <div class="admin-notice__panel">
        <p class="admin-notice__text"></p>
        <button type="button" class="admin-notice__btn">OK</button>
      </div>`;
    wrap.querySelector(".admin-notice__text").textContent = text;
    document.body.appendChild(wrap);

    const dismiss = () => {
      wrap.remove();
      if (onClose) onClose();
    };
    wrap.querySelector(".admin-notice__btn").addEventListener("click", dismiss);
    // Deliberately no overlay-click-to-dismiss when it's a forced
    // logout (onClose set) — that one should require an explicit tap
    // to acknowledge, not vanish by an accidental tap outside it.
    if (!onClose) {
      wrap.querySelector(".admin-notice__overlay").addEventListener("click", dismiss);
    }
  }

  // Generic activity logger — fires a silent background POST to the
  // Google Apps Script Web App URL in config.js, which appends a row
  // to a Google Sheet. Used for logins, PDF views, navigation, and
  // session start/end.
  //
  // type:   "login" | "session_start" | "session_end" | "view" |
  //         "view_end" | "navigate" | "heartbeat"
  // detail: free-form extra info (e.g. the file name, or whether a
  //         login attempt was authorized)
  // extra:  optional { viewId, duration } — duration is in seconds
  //
  // Note on mode: "no-cors" — Apps Script Web Apps don't answer the
  // CORS preflight browsers send for JSON POSTs, so a normal fetch
  // would fail silently anyway. "no-cors" plus a text/plain content
  // type keeps this a "simple request" (no preflight), and the sheet
  // still gets the row even though we can't read the response — same
  // fire-and-forget shape as the old Formspree call.
  function buildLogPayload(type, name, detail, pageOverride, extra) {
    return JSON.stringify({
      type,
      name: name || "",
      detail: detail || "",
      time: new Date().toISOString(),
      page: pageOverride || location.href,
      sessionId: sessionId || "",
      viewId: (extra && extra.viewId) || "",
      duration: (extra && extra.duration !== undefined && extra.duration !== null) ? extra.duration : ""
    });
  }

  function logEvent(type, name, detail, pageOverride, extra) {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) return;
    fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: buildLogPayload(type, name, detail, pageOverride, extra)
    }).catch(() => {});
  }

  // Same as logEvent, but for events that need to survive the tab
  // actually closing (session end, a PDF view ending as someone
  // leaves). A normal fetch can get killed mid-flight when the page
  // unloads; sendBeacon is built specifically to still deliver in
  // that moment. Falls back to a keepalive fetch on old browsers.
  function logEventBeacon(type, name, detail, pageOverride, extra) {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint || endpoint.indexOf("PASTE_YOUR") === 0) return;
    const payload = buildLogPayload(type, name, detail, pageOverride, extra);
    if (navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(endpoint, payload)) return;
      } catch {
        // fall through to fetch below
      }
    }
    fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payload
    }).catch(() => {});
  }

  // ── Navigation ─────────────────────────────────────────
  function nav(view, subjectId, folderId) {
    curView = view;
    curSubject = subjectId ? SITE_CONFIG.subjects.find((s) => s.id === subjectId) : null;
    curFolder = folderId && curSubject ? curSubject.subfolders.find((f) => f.id === folderId) : null;
    updateCrumbs();
    render();

    if (sessionId) {
      const where = curFolder ? `folder:${curFolder.name}` : curSubject ? `subject:${curSubject.name}` : "home";
      logEvent("navigate", currentName, where);
    }
  }

  function updateCrumbs() {
    let h = `<button class="crumb ${curView === 'home' ? 'crumb--active' : ''}" onclick="window.__nav('home')">Home</button>`;
    if (curView === "progress") {
      h += `<span class="crumb-sep">/</span>`;
      h += `<button class="crumb crumb--active">My Progress</button>`;
    }
    if (curView === "feedback") {
      h += `<span class="crumb-sep">/</span>`;
      h += `<button class="crumb crumb--active">Feedback</button>`;
    }
    if (curSubject) {
      h += `<span class="crumb-sep">/</span>`;
      h += `<button class="crumb ${curView === 'subject' ? 'crumb--active' : ''}" onclick="window.__nav('subject','${curSubject.id}')">${curSubject.name}</button>`;
    }
    if (curFolder) {
      h += `<span class="crumb-sep">/</span>`;
      h += `<button class="crumb crumb--active">${curFolder.name}</button>`;
    }
    breadcrumb.innerHTML = h;
  }

  window.__nav = (v, s, f) => nav(v, s, f);

  // ── Render ─────────────────────────────────────────────
  function render() {
    content.innerHTML = "";
    const query = searchInput ? searchInput.value.trim() : "";
    if (query) { renderSearchResults(query); return; }
    switch (curView) {
      case "home":      renderSubjects(); break;
      case "subject":   renderFolders();  break;
      case "subfolder": renderFiles();    break;
      case "progress":  renderProgress(); break;
      case "feedback":  renderFeedback(); break;
    }
  }

  // Flat search across every subject/folder/file — matches on the
  // file name, case-insensitive substring. Doesn't touch curView or
  // the breadcrumb, so clearing the box drops you back exactly where
  // you were, not back at Home.
  // ── My Progress ────────────────────────────────────────
  // Combines two different kinds of data on purpose: "opened" comes
  // from the server (the Log already tracks it, scoped by sessionId
  // so nobody can read anyone else's — same pattern as todayStats),
  // while "revised" is the self-marked, local-only checkbox above.
  // Percentage shown is based on REVISED, not opened — opening a file
  // isn't the same as being done with it, and revised is the number
  // that's actually the student's own judgment of their progress.
  // ── Feedback ───────────────────────────────────────────

  // A deliberately stricter check than the loose one-liners floating
  // around online — requires a real-looking domain with a proper,
  // alphabetic top-level domain (2–24 letters), and rejects
  // consecutive dots and leading/trailing dots. This is format
  // validation only — no code here can confirm the address actually
  // exists or belongs to the person without sending a real
  // verification email, which this feature doesn't do — but it does
  // reliably reject things like "asdf@asdf", "a@b.c", or
  // "test@@test.com" instead of letting anything with an @ sign through.
  function isValidEmail(email) {
    const trimmed = email.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.includes("..")) return false;
    const pattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,24}$/;
    return pattern.test(trimmed);
  }

  function renderFeedback() {
    const IMPROVEMENT_OPTIONS = ["More PDFs", "Faster loading", "Easier navigation", "Better design", "Nothing, it's great!"];
    let rating = 0;
    const selectedImprovements = new Set();

    const wrap = el("div", "feedback-page fade-up");
    wrap.innerHTML = `
      <div class="feedback-page__head">
        <span class="feedback-page__title">Help us improve</span>
        <span class="feedback-page__subtitle">Two quick questions — takes 15 seconds</span>
      </div>
      <div class="feedback-page__section">
        <p class="feedback-page__question">Your email <span class="feedback-required">*</span></p>
        <div class="feedback-email-wrap">
          <input type="email" id="feedbackEmail" class="feedback-input" placeholder="you@example.com" autocomplete="email" inputmode="email">
          <span class="feedback-email-check" id="feedbackEmailCheck"></span>
        </div>
        <p class="feedback-email-hint" id="feedbackEmailHint"></p>
      </div>
      <div class="feedback-page__section">
        <p class="feedback-page__question">How would you rate this portal overall?</p>
        <div class="feedback-stars" id="feedbackStars"></div>
      </div>
      <div class="feedback-page__section">
        <p class="feedback-page__question">What could we improve? (pick any)</p>
        <div class="feedback-chips" id="feedbackChips"></div>
      </div>
      <div class="feedback-page__section">
        <p class="feedback-page__question">Anything specific to add?</p>
        <textarea id="feedbackSuggestion" class="feedback-textarea" placeholder="Optional — a chapter that's missing, a bug you hit, anything at all" rows="4"></textarea>
      </div>
      <button type="button" id="feedbackSubmitBtn" class="feedback-submit-btn" disabled>Submit feedback</button>
    `;
    content.appendChild(wrap);

    const emailInput = wrap.querySelector("#feedbackEmail");
    const emailCheck = wrap.querySelector("#feedbackEmailCheck");
    const emailHint = wrap.querySelector("#feedbackEmailHint");
    const submitBtn = wrap.querySelector("#feedbackSubmitBtn");

    // Live — checked on every keystroke, not just on submit — so
    // someone typing "asdf" sees it's invalid immediately instead of
    // filling out the whole form first and only finding out at the end.
    // The submit button itself stays disabled the entire time the
    // email is invalid or empty, so there's no way to submit gibberish
    // by just ignoring the hint text.
    emailInput.addEventListener("input", () => {
      const value = emailInput.value;
      const valid = isValidEmail(value);
      submitBtn.disabled = !valid;
      emailInput.classList.toggle("feedback-input--valid", valid);
      emailInput.classList.toggle("feedback-input--invalid", value.length > 0 && !valid);
      emailCheck.innerHTML = valid ? "✓" : "";
      emailHint.textContent = value.length > 0 && !valid ? "Enter a real email address (e.g. name@gmail.com)" : "";
    });

    const starsEl = wrap.querySelector("#feedbackStars");
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement("button");
      star.type = "button";
      star.className = "feedback-star";
      star.dataset.value = String(i);
      star.innerHTML = ICONS.star;
      star.addEventListener("click", () => {
        rating = i;
        starsEl.querySelectorAll(".feedback-star").forEach((s) => {
          s.classList.toggle("feedback-star--active", Number(s.dataset.value) <= rating);
        });
      });
      starsEl.appendChild(star);
    }

    const chipsEl = wrap.querySelector("#feedbackChips");
    IMPROVEMENT_OPTIONS.forEach((opt) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "feedback-chip";
      chip.textContent = opt;
      chip.addEventListener("click", () => {
        if (selectedImprovements.has(opt)) selectedImprovements.delete(opt);
        else selectedImprovements.add(opt);
        chip.classList.toggle("feedback-chip--active");
      });
      chipsEl.appendChild(chip);
    });

    submitBtn.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      if (!isValidEmail(email)) {
        // Re-checked here too (not just trusting the live check /
        // disabled-button state) since the button's disabled attribute
        // can't be relied on as the only gate — belt and braces.
        emailInput.classList.add("feedback-input--invalid");
        emailHint.textContent = "Enter a real email address (e.g. name@gmail.com)";
        return;
      }
      const suggestion = wrap.querySelector("#feedbackSuggestion").value.trim();
      const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
      if (endpoint && endpoint.indexOf("PASTE_YOUR") !== 0) {
        try {
          await fetch(endpoint, {
            method: "POST",
            body: JSON.stringify({
              type: "feedback",
              name: currentName,
              email,
              rating: rating || "",
              improvements: Array.from(selectedImprovements),
              suggestion
            })
          });
        } catch {
          // best-effort — still show the thank-you either way, no point making someone retry a review
        }
      }
      wrap.innerHTML = `
        <div class="feedback-page__thanks">
          <span class="feedback-page__thanks-icon">${ICONS.star}</span>
          <p>Thanks — this genuinely helps.</p>
        </div>`;
      setTimeout(() => nav("home"), 1400);
    });
  }

  async function renderProgress() {
    const label = el("p", "section-label", "My Progress");
    content.appendChild(label);

    if (!sessionId) return;

    let viewedNames = new Set();
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (endpoint && endpoint.indexOf("PASTE_YOUR") !== 0) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${endpoint}?action=myProgress&sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
        clearTimeout(timeout);
        const data = await res.json();
        if (data && data.ok) viewedNames = new Set((data.viewedFiles || []).map((f) => f.file));
      } catch {
        // network hiccup — falls back to showing 0 opened rather than blocking the page
      }
    }

    SITE_CONFIG.subjects.forEach((s) => {
      const allFiles = s.subfolders.flatMap((f) => f.files.map((file) => ({ ...file, folderName: f.name })));
      const total = allFiles.length;
      if (!total) return;
      const openedCount = allFiles.filter((f) => viewedNames.has(f.name)).length;

      const card = el("div", "progress-subject fade-up");
      card.style.setProperty("--subject-color", s.color);

      const paintHeader = () => {
        const revisedCount = allFiles.filter((f) => getRevisedSet().has(f.path)).length;
        const pct = Math.round((revisedCount / total) * 100);
        card.querySelector(".progress-subject__pct").textContent = `${pct}%`;
        card.querySelector(".progress-bar__fill").style.width = `${pct}%`;
        card.querySelector(".progress-subject__stat").textContent = `${revisedCount}/${total} revised \u00B7 ${openedCount}/${total} opened`;
      };

      card.innerHTML = `
        <div class="progress-subject__head">
          <span class="progress-subject__icon">${ICONS[s.id] || ICONS.maths}</span>
          <div class="progress-subject__title">
            <h3>${s.name}</h3>
            <span class="progress-subject__stat"></span>
          </div>
          <span class="progress-subject__pct"></span>
        </div>
        <div class="progress-bar"><div class="progress-bar__fill"></div></div>
        <button type="button" class="progress-subject__toggle" data-toggle>Show files</button>
        <div class="progress-file-list hidden"></div>`;

      const fileList = card.querySelector(".progress-file-list");
      allFiles.forEach((f) => {
        const opened = viewedNames.has(f.name);
        const row = el("div", "progress-file-row");
        // Deliberately a plain <span>, not a button — this list is
        // for seeing what's left, not a shortcut to skip straight to
        // a file bypassing the normal subject/folder browsing.
        row.innerHTML = `
          <span class="progress-file-row__status ${opened ? "progress-file-row__status--opened" : ""}" title="${opened ? "Opened" : "Not opened yet"}">${opened ? "\u25CF" : "\u25CB"}</span>
          <span class="progress-file-row__name">${f.name}</span>
          <span class="progress-file-row__folder">${f.folderName}</span>
          <label class="progress-file-row__check">
            <input type="checkbox" ${getRevisedSet().has(f.path) ? "checked" : ""}>
            Revised
          </label>`;
        row.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
          setRevised(f.path, e.target.checked);
          paintHeader();
        });
        fileList.appendChild(row);
      });

      card.querySelector("[data-toggle]").addEventListener("click", () => {
        const willShow = fileList.classList.contains("hidden");
        fileList.classList.toggle("hidden");
        card.querySelector("[data-toggle]").textContent = willShow ? "Hide files" : "Show files";
      });

      paintHeader();
      content.appendChild(card);
    });
  }

  function renderSearchResults(query) {
    const q = query.toLowerCase();
    const matches = [];
    SITE_CONFIG.subjects.forEach((s) => {
      s.subfolders.forEach((f) => {
        f.files.forEach((file) => {
          if (file.name.toLowerCase().includes(q)) {
            matches.push({ file, subject: s, folder: f });
          }
        });
      });
    });

    const label = el("p", "section-label", `${matches.length} result${matches.length === 1 ? "" : "s"} for "${query}"`);

    if (!matches.length) {
      const empty = el("div", "empty fade-up");
      empty.innerHTML = `
        <div class="empty__icon">${ICONS.tray}</div>
        <p class="empty__title">Nothing matches "${query}"</p>
        <p class="empty__sub">Try a shorter word, or check the spelling</p>`;
      content.append(label, empty);
      return;
    }

    const grid = el("div", "files stagger");
    matches.forEach(({ file, subject, folder }) => {
      const card = el("div", "file-card fade-up");
      card.tabIndex = 0;

      const preview = el("div", "file-card__preview");
      const skeleton = el("div", "file-card__skeleton");
      skeleton.innerHTML = `${ICONS.doc}<span class="file-card__skeleton-text">Loading preview…</span>`;
      preview.appendChild(skeleton);
      const canvas = document.createElement("canvas");
      canvas.style.display = "none";
      preview.appendChild(canvas);
      observeThumbnail(preview, file.path, canvas, skeleton);

      card.addEventListener("click", () => openViewer(file.path, file.name));
      card.addEventListener("keydown", (e) => { if (e.key === "Enter") openViewer(file.path, file.name); });

      const info = el("div", "file-card__info");
      const nameP = el("p", "file-card__name");
      nameP.textContent = file.name;
      const typeP = el("p", "file-card__type", `${subject.name} · ${folder.name}`);
      info.append(nameP, typeP);

      card.append(preview, info);
      grid.appendChild(card);
    });

    content.append(label, grid);
  }

  // ── Subjects ───────────────────────────────────────────
  function renderSubjects() {
    // Big, prominent summary — the small nav icon was easy to miss;
    // this sits right up top so progress is the first thing seen on
    // the home screen. Percentage is revised-based, same metric as
    // the full My Progress page, so the two numbers always agree.
    const allFiles = SITE_CONFIG.subjects.flatMap((s) => s.subfolders.flatMap((f) => f.files));
    const totalFiles = allFiles.length;
    if (totalFiles && currentName) {
      const revisedSet = getRevisedSet();
      const revisedCount = allFiles.filter((f) => revisedSet.has(f.path)).length;
      const pct = Math.round((revisedCount / totalFiles) * 100);

      const banner = el("button", "progress-banner fade-up");
      banner.innerHTML = `
        <div class="progress-banner__text">
          <span class="progress-banner__label">My Progress</span>
          <span class="progress-banner__stat">${revisedCount}/${totalFiles} chapters revised</span>
        </div>
        <div class="progress-banner__pct">${pct}%</div>`;
      banner.addEventListener("click", () => nav("progress"));
      content.appendChild(banner);
    }

    // Always visible — explicitly kept, not hidden after someone
    // submits once. A one-time review shouldn't mean the option to
    // leave another disappears for good.
    if (currentName) {
      const feedbackBanner = el("button", "feedback-banner fade-up");
      feedbackBanner.innerHTML = `${ICONS.star}<span>Help us improve — leave a quick review</span>`;
      feedbackBanner.addEventListener("click", () => nav("feedback"));
      content.appendChild(feedbackBanner);
    }

    const recent = getRecentFiles();
    if (recent.length) {
      const rLabel = el("p", "section-label", "Continue where you left off");
      const rRow = el("div", "recent-row stagger");
      recent.forEach((r) => {
        const chip = el("button", "recent-chip fade-up");
        chip.innerHTML = `${ICONS.doc}<span class="recent-chip__name">${r.name}</span>`;
        chip.addEventListener("click", () => openViewer(r.path, r.name));
        rRow.appendChild(chip);
      });
      content.append(rLabel, rRow);
    }

    const bookmarks = getBookmarks();
    if (bookmarks.length) {
      const bLabel = el("p", "section-label", "Bookmarked");
      const bRow = el("div", "recent-row stagger");
      bookmarks.forEach((b) => {
        const chip = el("button", "recent-chip recent-chip--bookmark fade-up");
        chip.innerHTML = `${ICONS.star}<span class="recent-chip__name">${b.name}</span>`;
        chip.addEventListener("click", () => openViewer(b.path, b.name));
        bRow.appendChild(chip);
      });
      content.append(bLabel, bRow);
    }

    const label = el("p", "section-label", "Select a subject");
    const grid = el("div", "subjects stagger");

    SITE_CONFIG.subjects.forEach((s) => {
      const folderPreview = s.subfolders.map((f) => f.name).join(" · ");
      const card = el("div", "subject fade-up");
      card.style.setProperty("--subject-color", s.color);
      card.onclick = () => nav("subject", s.id);
      card.innerHTML = `
        <span class="subject__icon">${ICONS[s.id] || ICONS.maths}</span>
        <h2 class="subject__name">${s.name}</h2>
        <p class="subject__meta">${folderPreview}</p>
        <span class="subject__arrow">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
        </span>`;
      grid.appendChild(card);
    });

    content.append(label, grid);
  }

  // ── Subfolders ─────────────────────────────────────────
  function renderFolders() {
    if (!curSubject) return;
    const label = el("p", "section-label", curSubject.name);
    const list = el("div", "subfolders stagger");

    curSubject.subfolders.forEach((f) => {
      const row = el("div", "subfolder fade-up");
      row.onclick = () => nav("subfolder", curSubject.id, f.id);
      row.innerHTML = `
        <div class="subfolder__icon">${ICONS.folder}</div>
        <div class="subfolder__info">
          <div class="subfolder__name">${f.name}</div>
          <div class="subfolder__count">${f.files.length} file${f.files.length !== 1 ? 's' : ''}</div>
        </div>
        <span class="subfolder__chevron">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>`;
      list.appendChild(row);
    });

    content.append(label, list);
  }

  // ── Files (Grid with PDF Thumbnails) ───────────────────
  function renderFiles() {
    if (!curFolder) return;

    const label = el("p", "section-label", curFolder.name);

    if (curFolder.files.length === 0) {
      const empty = el("div", "empty fade-up");
      empty.innerHTML = `
        <div class="empty__icon">${ICONS.tray}</div>
        <p class="empty__title">Nothing filed here yet</p>
        <p class="empty__sub">Materials will appear once added to this folder</p>`;
      content.append(label, empty);
      return;
    }

    const grid = el("div", "files stagger");

    curFolder.files.forEach((file) => {
      const card = el("div", "file-card fade-up");
      card.tabIndex = 0;

      const preview = el("div", "file-card__preview");

      const skeleton = el("div", "file-card__skeleton");
      skeleton.innerHTML = `${ICONS.doc}<span class="file-card__skeleton-text">Loading preview…</span>`;
      preview.appendChild(skeleton);

      const canvas = document.createElement("canvas");
      canvas.style.display = "none";
      preview.appendChild(canvas);
      observeThumbnail(preview, file.path, canvas, skeleton);

      const overlay = el("div", "file-card__overlay");

      const viewBtn = document.createElement("button");
      viewBtn.className = "file-card__overlay-btn file-card__overlay-btn--view";
      viewBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> View`;
      viewBtn.addEventListener("click", (e) => { e.stopPropagation(); openViewer(file.path, file.name); });

      overlay.append(viewBtn);
      preview.appendChild(overlay);

      // Always-visible (not hover-only, unlike the overlay above) so
      // it's actually reachable on mobile, where there's no hover.
      const bookmarkBtn = document.createElement("button");
      bookmarkBtn.className = "file-card__bookmark" + (isBookmarked(file.path) ? " file-card__bookmark--active" : "");
      bookmarkBtn.setAttribute("aria-label", "Bookmark this file");
      bookmarkBtn.innerHTML = ICONS.star;
      bookmarkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleBookmark(file.path, file.name);
        bookmarkBtn.classList.toggle("file-card__bookmark--active");
      });
      preview.appendChild(bookmarkBtn);

      card.addEventListener("click", () => openViewer(file.path, file.name));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") openViewer(file.path, file.name);
      });

      const info = el("div", "file-card__info");
      const nameP = el("p", "file-card__name");
      nameP.textContent = file.name;
      const typeP = el("p", "file-card__type", "PDF");
      info.append(nameP, typeP);

      card.append(preview, info);
      grid.appendChild(card);
    });

    content.append(label, grid);
  }

  // ── PDF Thumbnail Rendering (pdf.js) ───────────────────
  // Caches a small JPEG snapshot of each rendered thumbnail so the
  // viewer can show it instantly as a placeholder — see openViewer.
  const thumbnailImageCache = new Map();

  function renderThumbnail(path, canvas, skeleton) {
    const textEl = skeleton.querySelector(".file-card__skeleton-text");
    if (!window.pdfjsLib) {
      textEl.textContent = "PDF";
      return Promise.resolve();
    }

    const loading = getPdfLoadingTask(path);

    // Only wire progress onto the skeleton if nothing else (e.g. an
    // already-open viewer for this same file) has claimed the task's
    // progress callback since.
    loading.onProgress = (p) => {
      if (p.total) {
        textEl.textContent = `Loading… ${Math.min(100, Math.round((p.loaded / p.total) * 100))}%`;
      }
    };

    return loading.promise.then((pdf) => {
      return withTimeout(
        pdf.getPage(1).then((page) => {
          const desiredWidth = 400;
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = desiredWidth / unscaledViewport.width;
          const viewport = page.getViewport({ scale });

          canvas.width = viewport.width;
          canvas.height = viewport.height;

          const ctx = canvas.getContext("2d");
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(() => {
            skeleton.style.display = "none";
            canvas.style.display = "block";
            try {
              // Low quality is fine — this is only ever shown briefly,
              // scaled up, as a stand-in for the real page.
              thumbnailImageCache.set(path, canvas.toDataURL("image/jpeg", 0.7));
            } catch {
              // toDataURL can throw in odd browser/security configs —
              // just skip the placeholder for this file, not fatal.
            }
          });
        }),
        15000,
        "Thumbnail render timed out"
      );
    }).catch(() => {
      textEl.textContent = "PDF";
      skeleton.style.animation = "none";
    });
  }

  // ── PDF Viewer ─────────────────────────────────────────
  // Renders every page to its own <canvas> via pdf.js, instead of
  // pointing an <iframe> at the raw file. Two reasons:
  //  1. No native browser/OS PDF handling involved at all — this is
  //     what fixes the iOS "stuck on thumbnail" and Android
  //     "just downloads instead of opening" behavior, since both of
  //     those come from each platform's own PDF plugin, not from
  //     this site. One consistent viewer now, same on every device.
  //  2. There's no visible `src="yourfile.pdf"` sitting in the page's
  //     HTML anymore for a "view source" to reveal instantly. It
  //     doesn't stop a DevTools Network-tab download (nothing
  //     browser-side can), but it closes the trivial route.
  let viewerLoadToken = 0;
  let currentPdf = null;
  let viewerZoom = 1;
  let pagesInner = null; // scaled independently of the scrolling outer container, so a live pinch can transform it without fighting scroll
  let pageObserver = null;   // lazy-renders the main page canvases as they scroll near-view
  let thumbObserver2 = null; // lazy-renders the thumbnail-strip canvases (separate from the folder-grid one above)
  // Tracks each page-wrap's in-flight pdf.js RenderTask (if any). Needed
  // wherever code is about to force a page to re-render despite one
  // already being underway (currently: a zoom change) — pdf.js does not
  // tolerate two concurrent render() calls sharing the same page
  // object, and can leave that page permanently unable to render again
  // for the rest of the session if it happens. Cancelling the old task
  // first (see cancelActiveRender below) avoids that outright instead
  // of hoping it never occurs.
  const activeRenderTasks = new Map(); // wrap -> RenderTask
  function cancelActiveRender(wrap) {
    const task = activeRenderTasks.get(wrap);
    if (task) {
      try { task.cancel(); } catch (e) { /* already finished/cancelled */ }
      activeRenderTasks.delete(wrap);
    }
  }
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_INCREMENT = 0.25;

  // ── Viewer viewport pinning ──────────────────────────────
  // In-app browsers (WhatsApp's, Chrome Custom Tabs, etc.) animate
  // their own toolbar in and out as you scroll, and some of them
  // don't reliably re-fire layout for a `position: fixed; inset: 0`
  // element when that happens — the toolbar collapses but the page
  // keeps painting as if it were still there, leaving a dead gap the
  // exact height of the vanished toolbar at the very top, above
  // everything including our bar. CSS alone can't detect that; the
  // VisualViewport API can, so we actively re-pin the viewer to it
  // whenever the browser reports its chrome changed.
  function syncViewerViewport() {
    if (!window.visualViewport || viewer.classList.contains("hidden")) return;
    const vv = window.visualViewport;
    viewer.style.top = `${vv.offsetTop}px`;
    viewer.style.height = `${vv.height}px`;
  }

  // ── Recently viewed (per-browser, scoped to this name) ──────────
  // Plain localStorage, not synced anywhere — purely a personal
  // convenience for "what was I just reading", so there's no reason
  // for it to touch the network or the Log sheet at all.
  function recentFilesKey() {
    return `c12_recent_${normalizeName(currentName || "")}`;
  }
  function getRecentFiles() {
    try {
      return JSON.parse(localStorage.getItem(recentFilesKey()) || "[]");
    } catch {
      return [];
    }
  }
  function addRecentFile(path, name) {
    if (!currentName) return;
    try {
      const list = getRecentFiles().filter((r) => r.path !== path);
      list.unshift({ path, name, ts: Date.now() });
      localStorage.setItem(recentFilesKey(), JSON.stringify(list.slice(0, 5)));
    } catch {
      // localStorage unavailable (private browsing, quota, etc.) — fine to just skip
    }
  }

  // ── Bookmarks (per-browser, scoped to this name) ────────────────
  // Same storage model as recently-viewed above, but manual and
  // uncapped — recently-viewed is "what did I just open" (automatic,
  // short); this is "what do I keep coming back to all term" (a
  // deliberate choice, kept until removed).
  function bookmarksKey() {
    return `c12_bookmarks_${normalizeName(currentName || "")}`;
  }
  function getBookmarks() {
    try {
      return JSON.parse(localStorage.getItem(bookmarksKey()) || "[]");
    } catch {
      return [];
    }
  }
  function isBookmarked(path) {
    return getBookmarks().some((b) => b.path === path);
  }
  function toggleBookmark(path, name) {
    if (!currentName) return;
    try {
      const list = getBookmarks();
      const idx = list.findIndex((b) => b.path === path);
      if (idx === -1) list.unshift({ path, name, ts: Date.now() });
      else list.splice(idx, 1);
      localStorage.setItem(bookmarksKey(), JSON.stringify(list));
    } catch {
      // localStorage unavailable — fine to just skip
    }
  }

  // ── Self-marked revision status (per-browser, scoped to this name) ──
  // Deliberately local, not server-side: "opened" is an objective fact
  // the Log already tracks; "revised" is a personal judgment call the
  // student makes about themselves, closer in spirit to bookmarks than
  // to anything admin needs to see or verify.
  function revisedKey() {
    return `c12_revised_${normalizeName(currentName || "")}`;
  }
  function getRevisedSet() {
    try {
      return new Set(JSON.parse(localStorage.getItem(revisedKey()) || "[]"));
    } catch {
      return new Set();
    }
  }
  function setRevised(path, isRevised) {
    if (!currentName) return;
    try {
      const set = getRevisedSet();
      if (isRevised) set.add(path);
      else set.delete(path);
      localStorage.setItem(revisedKey(), JSON.stringify(Array.from(set)));
    } catch {
      // localStorage unavailable — fine to just skip
    }
  }

  function openViewer(path, name) {
    endCurrentView(); // in case a different PDF was already open — close out its timer first
    viewerName.textContent = name;
    viewer.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    syncViewerViewport();
    currentViewId = makeId();
    currentViewName = name;
    currentViewActiveMs = 0;
    currentViewResumedAt = document.hidden ? null : Date.now();
    logEvent("view", currentName, name, undefined, { viewId: currentViewId });
    addRecentFile(path, name);

    viewerPages.innerHTML = "";
    currentPdf = null;
    viewerZoom = 1;
    updateZoomLabel();
    pagesInner = el("div", "viewer__pages-inner");

    const myToken = ++viewerLoadToken; // guards against a stale render finishing after the viewer's been closed/reopened

    // The instant cached-thumbnail placeholder that used to render here
    // is gone — it was showing up essentially all-black (a bad/undersized
    // JPEG snapshot from the folder grid) for a moment before the real
    // page swapped in, which is exactly the big dark block everyone kept
    // reporting. Simpler and reliable beats "instant but sometimes
    // broken": it's just the compact loading status below until the
    // real page is ready — nothing that can ever render as a stray
    // dark rectangle again.

    // Real progress bar instead of a plain "Loading…" label — a
    // determinate fill once the file size is known, falling back to
    // an indeterminate sliding animation if the server doesn't report
    // Content-Length. The point is just to keep showing the person
    // something is actively happening so they don't give up and leave.
    const status = el("div", "viewer__status");
    const statusText = el("p", "viewer__status-text", "Loading document…");
    const track = el("div", "viewer__progress-track viewer__progress-track--indeterminate");
    const fill = el("div", "viewer__progress-fill");
    track.appendChild(fill);
    status.append(statusText, track);
    viewerPages.appendChild(status);

    if (!window.pdfjsLib) {
      statusText.textContent = "Couldn't load the PDF viewer. Please refresh and try again.";
      track.remove();
      return;
    }

    // Reuses the same loading task the folder thumbnail already
    // started (see getPdfLoadingTask) — for a large scanned PDF whose
    // thumbnail has already rendered, this resolves instantly instead
    // of re-fetching the whole file a second time.
    const task = getPdfLoadingTask(path);
    task.onProgress = (p) => {
      if (myToken !== viewerLoadToken) return;
      if (p.total) {
        track.classList.remove("viewer__progress-track--indeterminate");
        const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
        fill.style.width = `${pct}%`;
        statusText.textContent = `Loading… ${pct}%`;
      }
    };

    task.promise.then((pdf) => {
      if (myToken !== viewerLoadToken) return;
      currentPdf = pdf;
      if (viewerPageTotal) viewerPageTotal.textContent = String(pdf.numPages);
      if (viewerPageInput) {
        viewerPageInput.value = 1;
        viewerPageInput.max = String(pdf.numPages);
      }
      status.remove();
      viewerPages.appendChild(pagesInner);
      return renderAllPages(myToken);
    }).catch((err) => {
      if (myToken !== viewerLoadToken) return;
      const reason = err && err.message;
      // "suspended"/"unauthorized" are the Apps Script's own error
      // codes (same convention as the rest of this backend) — surface
      // them specifically instead of a generic retry message that
      // would be actively wrong for someone who's actually been
      // blocked: retrying will never work for them, and telling them
      // to "try again" reads as a glitch rather than a real decision.
      let canRetry = true;
      if (reason === "suspended") {
        statusText.textContent = (SITE_CONFIG.suspended && SITE_CONFIG.suspended.message) || "You've lost access to this content.";
        canRetry = false;
      } else if (reason === "unauthorized") {
        statusText.textContent = "You're not authorized to view this file.";
        canRetry = false;
      } else {
        statusText.textContent = "Couldn't load this PDF.";
      }
      track.remove();
      // A dead-looking status line with no way forward is exactly what
      // read as "just stays blank" — this makes the next step obvious
      // and actually clickable, instead of requiring someone to work
      // out that closing and reopening the viewer would retry it.
      if (canRetry) {
        const retryBtn = el("button", "viewer__btn viewer__retry-btn", "Tap to retry");
        retryBtn.type = "button";
        retryBtn.addEventListener("click", () => openViewer(path, name));
        status.appendChild(retryBtn);
      }
    });
  }

  function drawWatermark(ctx, canvas) {
    const label = `${currentName || "unknown"} · ${new Date().toLocaleDateString()}`;
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = "#000";
    ctx.font = `${Math.round(canvas.width / 22)}px Archivo, sans-serif`;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(-Math.PI / 6);
    const stepX = canvas.width * 0.6;
    const stepY = canvas.height * 0.22;
    for (let y = -canvas.height; y < canvas.height; y += stepY) {
      for (let x = -canvas.width; x < canvas.width; x += stepX) {
        ctx.fillText(label, x, y);
      }
    }
    ctx.restore();
  }

  // Renders ONE page into its already-placed, already-correctly-sized wrap div.
  // Can be called lazily via IntersectionObserver or directly on thumbnail/link click
  // so jumping to any page (e.g. page 45) renders immediately without a blank sheet.
  function renderPageInto(wrap, pageNum) {
    if (!wrap || !currentPdf) return;
    if (wrap.dataset.rendered || wrap.dataset.rendering) return;
    wrap.dataset.rendering = "1";
    const myToken = viewerLoadToken;
    const pdf = currentPdf;
    const dpr = window.devicePixelRatio || 1;

    withTimeout(pdf.getPage(pageNum), 15000, "Page load timed out").then((page) => {
      if (myToken !== viewerLoadToken) {
        delete wrap.dataset.rendering;
        return;
      }
      const unscaledViewport = page.getViewport({ scale: 1 });
      wrap.dataset.aspect = String(unscaledViewport.height / unscaledViewport.width);

      const baseWidth = Math.min(viewerPages.clientWidth - 32, 900);
      const displayWidth = Math.round(baseWidth * viewerZoom);
      const displayHeight = Math.round(displayWidth * (unscaledViewport.height / unscaledViewport.width));

      wrap.style.width = `${displayWidth}px`;
      wrap.style.height = `${displayHeight}px`;

      const renderScale = (displayWidth / unscaledViewport.width) * dpr;
      const viewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement("canvas");
      canvas.className = "viewer__page";
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext("2d");
      const renderTask = page.render({ canvasContext: ctx, viewport });
      activeRenderTasks.set(wrap, renderTask);
      return withTimeout(
        renderTask.promise,
        15000,
        "Page render timed out"
      ).then(() => {
        if (activeRenderTasks.get(wrap) === renderTask) activeRenderTasks.delete(wrap);
        if (myToken !== viewerLoadToken) {
          delete wrap.dataset.rendering;
          return;
        }
        delete wrap.dataset.rendering;
        wrap.dataset.rendered = "1";

        drawWatermark(ctx, canvas);

        // Remove loading shimmer once rendered
        const shimmer = wrap.querySelector(".viewer__page-shimmer");
        if (shimmer) shimmer.remove();

        // Swap canvas safely: remove any existing canvas and append new one (no flash)
        const oldCanvas = wrap.querySelector("canvas.viewer__page");
        if (oldCanvas) oldCanvas.remove();
        wrap.appendChild(canvas);

        // Remove old annotation layer if present
        const oldAnno = wrap.querySelector(".annotationLayer");
        if (oldAnno) oldAnno.remove();

        // ── Annotation Layer for clickable PDF links (TOC, Index, External) ──
        try {
          page.getAnnotations({ intent: "display" }).then((annots) => {
            if (myToken !== viewerLoadToken || !annots || !annots.length) return;
            const cssScale = displayWidth / unscaledViewport.width;
            const annoViewport = page.getViewport({ scale: cssScale });

            const annoDiv = document.createElement("div");
            annoDiv.className = "annotationLayer";
            annoDiv.style.width = `${displayWidth}px`;
            annoDiv.style.height = `${displayHeight}px`;
            annoDiv.style.setProperty("--scale-factor", String(cssScale));
            wrap.appendChild(annoDiv);

            const linkService = {
              getDestinationHash: () => "#",
              getAnchorUrl: () => "#",
              addLinkAttributes: (element, url) => {
                element.href = url;
                element.target = "_blank";
                element.rel = "noopener noreferrer nofollow";
              },
              goToDestination: (dest) => {
                if (typeof dest === "string") {
                  pdf.getDestination(dest).then((d) => {
                    if (d) pdf.getPageIndex(d[0]).then((idx) => scrollToPage(idx + 1));
                  });
                } else if (Array.isArray(dest)) {
                  pdf.getPageIndex(dest[0]).then((idx) => scrollToPage(idx + 1));
                }
              },
              navigateTo: (dest) => {
                if (typeof dest === "string") {
                  pdf.getDestination(dest).then((d) => {
                    if (d) pdf.getPageIndex(d[0]).then((idx) => scrollToPage(idx + 1));
                  });
                } else if (Array.isArray(dest)) {
                  pdf.getPageIndex(dest[0]).then((idx) => scrollToPage(idx + 1));
                }
              },
              executeNamedAction: () => {}
            };

            const layer = new pdfjsLib.AnnotationLayer({
              div: annoDiv,
              page: page,
              viewport: annoViewport
            });

            layer.render({
              annotations: annots,
              linkService: linkService,
              renderForms: false,
              enableScripting: false
            });
          });
        } catch (annoErr) {
          // Best-effort — link failures never crash the viewer
        }
      });
    }).catch((err) => {
      // Was previously a silent dead end: dataset.rendering never got
      // cleared on a hang (there was nothing to time it out), so this
      // page could never be retried by anything — not a re-scroll, not
      // an explicit jump. Now a failure/timeout clears both flags and
      // turns the shimmer itself into a retry button, so the page can
      // actually recover instead of staying blank forever.
      activeRenderTasks.delete(wrap);
      delete wrap.dataset.rendering;
      delete wrap.dataset.rendered;
      // A cancellation (from cancelActiveRender, e.g. a zoom change
      // superseding this render) isn't a failure — a fresh render for
      // this same page is already on its way in, so don't flash an
      // error state for it.
      if (err && err.name === "RenderingCancelledException") return;
      const shimmer = wrap.querySelector(".viewer__page-shimmer");
      if (shimmer) {
        shimmer.classList.add("viewer__page-shimmer--failed");
        shimmer.innerHTML = `<span class="viewer__page-shimmer-text">Couldn't load page ${pageNum} — tap to retry</span>`;
        shimmer.onclick = () => {
          shimmer.classList.remove("viewer__page-shimmer--failed");
          shimmer.innerHTML = `<span class="viewer__page-shimmer-text">Page ${pageNum}</span>`;
          renderPageInto(wrap, pageNum);
        };
      }
    });
  }

  function renderAllPages(token) {
    if (!pagesInner) return Promise.resolve();
    pagesInner.querySelectorAll(".viewer__page-wrap").forEach((c) => { cancelActiveRender(c); c.remove(); });
    viewerThumbStrip.innerHTML = "";
    if (pageObserver) pageObserver.disconnect();
    if (thumbObserver2) thumbObserver2.disconnect();
    const pdf = currentPdf;
    if (!pdf) return Promise.resolve();

    // Generous rootMargin (2000px) ensures fast scrolling loads smoothly in advance
    pageObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const wrap = entry.target;
        renderPageInto(wrap, Number(wrap.dataset.pageNum));
      });
    }, { root: viewerPages, rootMargin: "2000px 0px 2000px 0px" });

    // Thumbnail strip observer
    thumbObserver2 = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const item = entry.target;
        if (item.dataset.rendered) return;
        item.dataset.rendered = "1";
        const pageNum = Number(item.dataset.pageNum);
        const canvas = item.querySelector("canvas");
        pdf.getPage(pageNum).then((page) => {
          if (token !== viewerLoadToken) return;
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = 90 / unscaledViewport.width;
          const viewport = page.getViewport({ scale });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          return page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        }).catch(() => {});
      });
    }, { root: viewerThumbStrip, rootMargin: "400px 0px 400px 0px" });

    // Fetch ONLY Page 1 to obtain initial aspect ratio (Page 1 is already cached from thumbnail!)
    // Generating placeholders for all pages takes <1ms with zero extra network requests!
    // Wrapped in withTimeout: this used to be the single point of
    // failure for the entire document — if this one call hung, NOTHING
    // downstream of it ever ran, so not one page-wrap, shimmer, or
    // error message ever appeared. That's what a truly blank viewer
    // with no loading indicator at all (not even the per-page shimmer,
    // since nothing had been created yet to show one) actually was.
    return withTimeout(pdf.getPage(1), 15000, "Couldn't load page 1").then((firstPage) => {
      if (token !== viewerLoadToken) return;
      const unscaledFirst = firstPage.getViewport({ scale: 1 });
      const defaultAspect = unscaledFirst.height / unscaledFirst.width;
      const baseWidth = Math.min(viewerPages.clientWidth - 32, 900);
      const displayWidth = Math.round(baseWidth * viewerZoom);
      const displayHeight = Math.round(displayWidth * defaultAspect);

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const wrap = el("div", "viewer__page-wrap");
        wrap.dataset.pageNum = String(pageNum);
        wrap.dataset.aspect = String(defaultAspect);
        wrap.style.width = `${displayWidth}px`;
        wrap.style.height = `${displayHeight}px`;

        // Page number label visible on each page in the main viewer
        const pageLabel = el("span", "viewer__page-num", String(pageNum));
        wrap.appendChild(pageLabel);

        // Loading shimmer until page canvas renders
        const shimmer = el("div", "viewer__page-shimmer");
        shimmer.innerHTML = `<span class="viewer__page-shimmer-text">Page ${pageNum}</span>`;
        wrap.appendChild(shimmer);

        pagesInner.appendChild(wrap);
        pageObserver.observe(wrap);

        // Thumbnail item
        const thumbItem = el("div", "viewer__thumb-item");
        thumbItem.dataset.pageNum = String(pageNum);
        if (pageNum === 1) thumbItem.classList.add("viewer__thumb-item--current");
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.style.aspectRatio = `${unscaledFirst.width} / ${unscaledFirst.height}`;
        const thumbLabel = el("span", "viewer__thumb-item-num", String(pageNum));
        thumbItem.append(thumbCanvas, thumbLabel);

        // Clicking a thumbnail jumps directly to that page AND keeps thumbnail strip open
        thumbItem.addEventListener("click", () => {
          scrollToPage(pageNum);
        });

        viewerThumbStrip.appendChild(thumbItem);
        thumbObserver2.observe(thumbItem);
      }

      // Render Page 1 immediately
      const firstWrap = pagesInner.querySelector(`.viewer__page-wrap[data-page-num="1"]`);
      if (firstWrap) renderPageInto(firstWrap, 1);
    }).catch((err) => {
      if (token !== viewerLoadToken) return;
      // Nothing got created above — show a real, visible retry state
      // in the empty viewer instead of leaving it blank.
      const status = el("div", "viewer__status");
      status.append(el("p", "viewer__status-text", "Couldn't load this PDF."));
      const retryBtn = el("button", "viewer__btn viewer__retry-btn", "Tap to retry");
      retryBtn.type = "button";
      retryBtn.addEventListener("click", () => {
        status.remove();
        renderAllPages(token);
      });
      status.appendChild(retryBtn);
      viewerPages.appendChild(status);
    });
  }

  // ── Jump to Page / Scroll to Page ──────────────────────────
  // Instantly renders the target page and adjacent pages so distant jumps (e.g. page 45)
  // never sit on a blank screen.
  function scrollToPage(pageNum) {
    if (!currentPdf || !pagesInner) return;
    pageNum = Math.max(1, Math.min(currentPdf.numPages, pageNum));
    const wrap = pagesInner.querySelector(`.viewer__page-wrap[data-page-num="${pageNum}"]`);
    if (!wrap) return;

    wrap.scrollIntoView({ block: "start", behavior: "smooth" });
    updateCurrentPageDisplay(pageNum);
    highlightThumbnail(pageNum);

    // Only recover a page that's genuinely stuck — flagged "rendered"
    // with no canvas ever appended (a leftover from an older bug).
    // Deliberately NOT touching dataset.rendering here: this function
    // runs on every jump (a link click, a thumbnail tap, typing a page
    // number), including jumps to a page that's already mid-render
    // right now — e.g. one just prefetched a moment ago as the
    // "next page" of a previous jump. Clearing that flag would let
    // THIS call start a second, concurrent render of the very same
    // PDF page on top of the one already running. pdf.js does not
    // tolerate that: the two render tasks fight over the same shared
    // page object, and it's left unable to ever render again for the
    // rest of the session — that page then reads as permanently blank
    // no matter how many times you click the link or scroll to it,
    // which matches exactly what was being reported: works once,
    // then never again, for that specific page.
    if (wrap.dataset.rendered && !wrap.querySelector("canvas.viewer__page")) {
      delete wrap.dataset.rendered;
    }

    // Render target page immediately — do NOT wait on IntersectionObserver.
    // Safe to call even if a render is already in progress or done —
    // renderPageInto's own guard just no-ops in that case.
    renderPageInto(wrap, pageNum);

    // Pre-render adjacent pages for instantaneous responsiveness
    if (pageNum > 1) {
      const prevWrap = pagesInner.querySelector(`.viewer__page-wrap[data-page-num="${pageNum - 1}"]`);
      if (prevWrap) renderPageInto(prevWrap, pageNum - 1);
    }
    if (pageNum < currentPdf.numPages) {
      const nextWrap = pagesInner.querySelector(`.viewer__page-wrap[data-page-num="${pageNum + 1}"]`);
      if (nextWrap) renderPageInto(nextWrap, pageNum + 1);
    }
  }

  function updateCurrentPageDisplay(pageNum) {
    if (viewerPageInput && document.activeElement !== viewerPageInput) {
      viewerPageInput.value = pageNum;
    }
    if (viewerPrevPage) viewerPrevPage.disabled = (pageNum <= 1);
    if (viewerNextPage) viewerNextPage.disabled = (currentPdf && pageNum >= currentPdf.numPages);
  }

  function highlightThumbnail(pageNum) {
    if (!viewerThumbStrip) return;
    viewerThumbStrip.querySelectorAll(".viewer__thumb-item").forEach((t) => {
      const isCurrent = Number(t.dataset.pageNum) === pageNum;
      t.classList.toggle("viewer__thumb-item--current", isCurrent);
      if (isCurrent && viewerThumbStrip.classList.contains("viewer__thumb-strip--open")) {
        t.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  let viewerScrollDebounce = null;
  function onViewerScroll() {
    if (!currentPdf || !pagesInner) return;
    if (viewerScrollDebounce) return;
    viewerScrollDebounce = setTimeout(() => {
      viewerScrollDebounce = null;
      if (!pagesInner || !viewerPages) return;
      const wraps = pagesInner.querySelectorAll(".viewer__page-wrap");
      const targetMid = viewerPages.scrollTop + viewerPages.clientHeight / 3;
      let closestPage = 1;
      let minDiff = Infinity;
      wraps.forEach((w) => {
        const top = w.offsetTop;
        const diff = Math.abs(top - targetMid);
        if (diff < minDiff) {
          minDiff = diff;
          closestPage = Number(w.dataset.pageNum);
        }
      });
      updateCurrentPageDisplay(closestPage);
      highlightThumbnail(closestPage);
    }, 80);
  }

  function prevPage() {
    const cur = parseInt(viewerPageInput ? viewerPageInput.value : "1", 10) || 1;
    if (cur > 1) scrollToPage(cur - 1);
  }

  function nextPage() {
    if (!currentPdf) return;
    const cur = parseInt(viewerPageInput ? viewerPageInput.value : "1", 10) || 1;
    if (cur < currentPdf.numPages) scrollToPage(cur + 1);
  }

  function fitToWidth() {
    if (!currentPdf || !pagesInner) return;
    const baseWidth = Math.min(viewerPages.clientWidth - 32, 900);
    const availableWidth = viewerPages.clientWidth - 32;
    const targetZoom = availableWidth / baseWidth;
    setZoom(targetZoom);
  }

  function fitToPage() {
    if (!currentPdf || !pagesInner) return;
    const firstWrap = pagesInner.querySelector(".viewer__page-wrap");
    const aspect = firstWrap ? (Number(firstWrap.dataset.aspect) || 1.414) : 1.414;
    const baseWidth = Math.min(viewerPages.clientWidth - 32, 900);
    const availableHeight = viewerPages.clientHeight - 40;
    const targetWidth = availableHeight / aspect;
    const targetZoom = targetWidth / baseWidth;
    setZoom(targetZoom);
  }

  function updateZoomLabel() {
    const label = $("#viewerZoomLabel");
    if (label) label.textContent = `${Math.round(viewerZoom * 100)}%`;
    const inBtn = $("#viewerZoomIn");
    const outBtn = $("#viewerZoomOut");
    if (inBtn) inBtn.disabled = (viewerZoom >= ZOOM_MAX);
    if (outBtn) outBtn.disabled = (viewerZoom <= ZOOM_MIN);
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  // ── Flicker-Free Synchronous Zoom ────────────────────────
  // Resizes page containers immediately via cached aspect ratios (0 promises, 1ms),
  // scales existing canvases with zero flicker, and re-renders visible pages at high DPI.
  function setZoom(next, pinchAnchor) {
    next = Math.round(clampZoom(next) * 100) / 100;
    if (!currentPdf || next === viewerZoom) {
      if (pagesInner) pagesInner.style.transform = "";
      return;
    }
    const prevZoom = viewerZoom;
    viewerZoom = next;
    updateZoomLabel();
    viewerLoadToken++;

    const allWraps = pagesInner ? Array.from(pagesInner.querySelectorAll(".viewer__page-wrap")) : [];
    const baseWidth = Math.min(viewerPages.clientWidth - 32, 900);
    const newWidth = Math.round(baseWidth * viewerZoom);

    let restoreScroll;
    if (pinchAnchor) {
      const scaleRatio = next / prevZoom;
      const targetContentX = pinchAnchor.contentX * scaleRatio;
      const targetContentY = pinchAnchor.contentY * scaleRatio;
      restoreScroll = () => {
        viewerPages.scrollLeft = targetContentX - pinchAnchor.viewportOffsetX;
        viewerPages.scrollTop = targetContentY - pinchAnchor.viewportOffsetY;
      };
    } else {
      const maxScrollBefore = viewerPages.scrollHeight - viewerPages.clientHeight;
      const scrollRatio = maxScrollBefore > 0 ? viewerPages.scrollTop / maxScrollBefore : 0;
      restoreScroll = () => {
        const maxScrollAfter = viewerPages.scrollHeight - viewerPages.clientHeight;
        viewerPages.scrollTop = maxScrollAfter > 0 ? scrollRatio * maxScrollAfter : 0;
      };
    }

    // Step 1: Instantly and synchronously resize all wraps in 1 millisecond
    allWraps.forEach((wrap) => {
      const aspect = Number(wrap.dataset.aspect) || 1.414;
      const newHeight = Math.round(newWidth * aspect);
      wrap.style.width = `${newWidth}px`;
      wrap.style.height = `${newHeight}px`;

      const annoLayer = wrap.querySelector(".annotationLayer");
      if (annoLayer) {
        annoLayer.style.width = `${newWidth}px`;
        annoLayer.style.height = `${newHeight}px`;
      }

      delete wrap.dataset.rendered;
      delete wrap.dataset.rendering;
      cancelActiveRender(wrap); // a render for this page may genuinely still be running from before the zoom — cancel it explicitly rather than just abandoning it, since pdf.js can't safely run two render() calls on the same page at once
    });

    if (pagesInner) pagesInner.style.transform = "";

    restoreScroll();

    // Step 2: Re-observe visible pages with IntersectionObserver so visible pages get re-rendered at new high-res scale
    if (pageObserver) pageObserver.disconnect();
    pageObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const wrap = entry.target;
        renderPageInto(wrap, Number(wrap.dataset.pageNum));
      });
    }, { root: viewerPages, rootMargin: "2000px 0px 2000px 0px" });

    allWraps.forEach((wrap) => pageObserver.observe(wrap));
  }

  function zoomIn() {
    setZoom(viewerZoom + ZOOM_INCREMENT);
  }

  function zoomOut() {
    setZoom(viewerZoom - ZOOM_INCREMENT);
  }

  // ── Pinch-to-zoom ────────────────────────────────────────
  // Native pinch was disabled on purpose (touch-action: pan-x pan-y
  // in CSS) because it just stretches the already-rendered canvas —
  // pinch out far enough and it goes visibly blurry. This gives the
  // same real pinch gesture back without that trade-off: while the
  // fingers are moving, a cheap CSS transform on the pages wrapper
  // tracks them live for instant visual feedback; the moment the
  // gesture ends, the transform resets and a single real re-render
  // happens at the new zoom level through the normal high-res path.
  let pinchStartDist = null;
  let pinchStartZoom = 1;
  let pinchLiveZoom = null;
  let pinchAnchor = null; // set at touchstart — the content-space point under the fingers, kept fixed for the whole gesture

  function touchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchMidpoint(touches) {
    const [a, b] = touches;
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function onViewerTouchStart(e) {
    if (e.touches.length === 2 && currentPdf && pagesInner) {
      pinchStartDist = touchDistance(e.touches);
      pinchStartZoom = viewerZoom;

      // Anchor the zoom to wherever the fingers actually are, not the
      // center of the whole document (pagesInner's own default
      // transform-origin) — for anything longer than one screen's
      // worth of page, that center could be hundreds of pixels from
      // where someone is actually pinching, which is exactly what made
      // this feel uncontrollable: content zoomed from a point you
      // weren't even looking at.
      const mid = touchMidpoint(e.touches);
      const rect = viewerPages.getBoundingClientRect();
      const contentX = mid.x - rect.left + viewerPages.scrollLeft;
      const contentY = mid.y - rect.top + viewerPages.scrollTop;
      pagesInner.style.transformOrigin = `${contentX}px ${contentY}px`;
      pinchAnchor = {
        contentX,
        contentY,
        viewportOffsetX: mid.x - rect.left, // fingers' position relative to the viewer, not the page — this is what "under the fingers" gets restored to after the real re-render
        viewportOffsetY: mid.y - rect.top
      };
    }
  }

  function onViewerTouchMove(e) {
    if (e.touches.length === 2 && pinchStartDist && pagesInner) {
      e.preventDefault();
      const scale = touchDistance(e.touches) / pinchStartDist;
      pinchLiveZoom = clampZoom(pinchStartZoom * scale);
      pagesInner.style.transform = `scale(${pinchLiveZoom / pinchStartZoom})`;
    }
  }

  function onViewerTouchEnd(e) {
    if (pinchStartDist !== null && e.touches.length < 2) {
      pinchStartDist = null;
      const finalZoom = pinchLiveZoom;
      const anchor = pinchAnchor;
      pinchLiveZoom = null;
      pinchAnchor = null;
      if (finalZoom !== null) setZoom(finalZoom, anchor);
      else if (pagesInner) pagesInner.style.transform = "";
    }
  }

  function closeViewer() {
    endCurrentView();
    viewer.classList.add("hidden");
    viewer.style.top = "";
    viewer.style.height = "";
    viewerLoadToken++; // invalidate any render still in flight
    currentPdf = null;
    pagesInner = null;
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    if (thumbObserver2) { thumbObserver2.disconnect(); thumbObserver2 = null; }
    activeRenderTasks.forEach((task) => { try { task.cancel(); } catch (e) {} });
    activeRenderTasks.clear();
    viewerThumbStrip.classList.remove("viewer__thumb-strip--open");
    viewerThumbStrip.innerHTML = "";
    viewerPages.innerHTML = "";
    viewerPages.scrollTop = 0;
    document.body.style.overflow = "";
  }

  // Ends the currently-open PDF's timer (if any) and logs how long it
  // was actually on screen — foreground time only, since the pause on
  // tab-hidden/visible below stops the clock while the tab is
  // backgrounded. Sent via beacon so it survives the tab closing too.
  function endCurrentView() {
    if (!currentViewId) return;
    if (currentViewResumedAt !== null) {
      currentViewActiveMs += Date.now() - currentViewResumedAt;
      currentViewResumedAt = null;
    }
    const seconds = Math.round(currentViewActiveMs / 1000);
    logEventBeacon("view_end", currentName, currentViewName, undefined, { viewId: currentViewId, duration: seconds });
    currentViewId = null;
    currentViewName = null;
    currentViewActiveMs = 0;
  }

  // ── Admin Dashboard ──────────────────────────────────────
  // Everything here reads fresh from the sheet on every open — no
  // client-side caching between visits, per your request. The only
  // "live" piece is the online-now list, which re-polls on an
  // interval while the dashboard is actually open.

  let adminPresenceTimer = null;
  let fileSubjectMap = null;

  function adminEndpointUrl(action, params) {
    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    const url = new URL(endpoint);
    url.searchParams.set("action", action);
    url.searchParams.set("key", adminApiToken || "");
    if (params) Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
    return url.toString();
  }

  async function adminFetch(action, params) {
    try {
      const res = await fetch(adminEndpointUrl(action, params));
      const data = await res.json();
      return (data && data.ok) ? data : null;
    } catch {
      return null;
    }
  }

  // Maps a file's display name (what's logged as `detail` on view
  // events) back to which subject/folder it lives under, using the
  // same SITE_CONFIG this page already has — no need for the backend
  // to know anything about subjects.
  function getFileSubjectMap() {
    if (fileSubjectMap) return fileSubjectMap;
    fileSubjectMap = {};
    SITE_CONFIG.subjects.forEach((s) => {
      s.subfolders.forEach((f) => {
        f.files.forEach((file) => {
          fileSubjectMap[file.name] = { subject: s.name, folder: f.name };
        });
      });
    });
    return fileSubjectMap;
  }

  function enterAdmin() {
    gate.classList.add("hidden");
    app.classList.add("hidden");
    adminApp.classList.remove("hidden");
    refreshAdmin();
    stopAdminPolling();
    adminPresenceTimer = setInterval(renderAdminPresence, 20000);
  }

  function exitAdmin() {
    stopAdminPolling();
    closeAdminDetail();
    adminApp.classList.add("hidden");
    gate.classList.remove("hidden");
  }

  function stopAdminPolling() {
    if (adminPresenceTimer) {
      clearInterval(adminPresenceTimer);
      adminPresenceTimer = null;
    }
  }

  let lastRosterPeople = [];
  let selectedForMerge = new Set();

  // ── Toast + confirm (replaces browser alert()/confirm()) ────────
  // Native alert()/confirm() are functional but visually jarring —
  // they look nothing like the rest of this site and interrupt
  // rather than fit into the page. These are drop-in equivalents:
  // showToast for a fire-and-forget message, showConfirm returning a
  // Promise<boolean> so call sites read almost the same as before
  // (just add "await" and drop the negation).
  function showToast(message, isError) {
    const toast = el(`div`, `toast${isError ? " toast--error" : ""}`, message);
    toastStack.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      confirmMessage.textContent = message;
      confirmInput.classList.add("hidden");
      confirmOverlay.classList.remove("hidden");
      const cleanup = (result) => {
        confirmOverlay.classList.add("hidden");
        confirmOkBtn.removeEventListener("click", onOk);
        confirmCancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      confirmOkBtn.addEventListener("click", onOk);
      confirmCancelBtn.addEventListener("click", onCancel);
    });
  }

  // Same overlay as showConfirm, with the text input shown — a
  // drop-in replacement for the browser's native prompt(), which
  // (like alert()/confirm()) looks nothing like the rest of this
  // site. Resolves to the typed string, or null on Cancel — same
  // contract as prompt() itself, so call sites barely change.
  function showPrompt(message, defaultValue) {
    return new Promise((resolve) => {
      confirmMessage.textContent = message;
      confirmInput.value = defaultValue || "";
      confirmInput.classList.remove("hidden");
      confirmOverlay.classList.remove("hidden");
      confirmInput.focus();
      const cleanup = (result) => {
        confirmOverlay.classList.add("hidden");
        confirmInput.classList.add("hidden");
        confirmOkBtn.removeEventListener("click", onOk);
        confirmCancelBtn.removeEventListener("click", onCancel);
        confirmInput.removeEventListener("keydown", onKeydown);
        resolve(result);
      };
      const onOk = () => cleanup(confirmInput.value);
      const onCancel = () => cleanup(null);
      const onKeydown = (e) => {
        if (e.key === "Enter") onOk();
        if (e.key === "Escape") onCancel();
      };
      confirmOkBtn.addEventListener("click", onOk);
      confirmCancelBtn.addEventListener("click", onCancel);
      confirmInput.addEventListener("keydown", onKeydown);
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────
  function switchAdminTab(tabName) {
    $$(".admin__tab", adminTabs).forEach((btn) => {
      btn.classList.toggle("admin__tab--active", btn.dataset.tab === tabName);
    });
    $$(".admin__tab-panel").forEach((panel) => {
      panel.classList.toggle("admin__tab-panel--active", panel.dataset.panel === tabName);
    });
  }

  function renderSummaryStrip(online, flags, queue, bandwidth) {
    const flagCount = (flags.deviceCycling || []).length + (flags.rapidRepeat || []).length + (flags.bulkView || []).length;
    const cards = [
      { num: online.length, label: "Online now" },
      { num: flagCount, label: "Flagged", alert: flagCount > 0 },
      { num: queue.length, label: "Pending approval", alert: queue.length > 0 }
    ];
    if (bandwidth) {
      const usedGB = (bandwidth.usedBytes / (1024 ** 3)).toFixed(2);
      const limitGB = (bandwidth.limitBytes / (1024 ** 3)).toFixed(1);
      const pct = bandwidth.limitBytes ? Math.round((bandwidth.usedBytes / bandwidth.limitBytes) * 100) : 0;
      cards.push({
        num: `${usedGB}/${limitGB} GB`,
        label: "Bandwidth today",
        alert: pct >= 80
      });
    }
    adminSummaryStrip.innerHTML = cards.map((c) => `
      <div class="admin__summary-card${c.alert ? " admin__summary-card--alert" : ""}">
        <div class="admin__summary-card__num">${c.num}</div>
        <div class="admin__summary-card__label">${c.label}</div>
      </div>`).join("");
  }

  async function renderBlockedDevices(preloaded) {
    const data = preloaded ? { ok: true, devices: preloaded } : await adminFetch("blockedDevicesFull");
    if (!data) {
      adminBlockedDevicesList.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
      return;
    }
    const devices = data.devices || [];
    adminBlockedDevicesList.innerHTML = "";
    if (!devices.length) {
      adminBlockedDevicesList.innerHTML = `<p class="admin__empty">Nothing blocked</p>`;
      return;
    }
    devices.forEach((d) => {
      const when = d.firstBlockedAt ? new Date(d.firstBlockedAt).toLocaleString() : "";
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${d.label || "Unknown device"}</span>
          <span class="admin__presence-meta">${d.deviceId.slice(0, 12)}\u2026 \u00B7 blocked ${when}</span>
        </div>
        <div class="admin__presence-actions">
          <button type="button" class="admin__presence-btn" data-action="unblock">Unblock</button>
        </div>`;
      row.querySelector('[data-action="unblock"]').addEventListener("click", async () => {
        if (!(await showConfirm(`Unblock this device? Anyone using it will be able to log in again (under any non-suspended name).`))) return;
        await adminFetch("unblockDevice", { deviceId: d.deviceId });
        renderBlockedDevices();
      });
      adminBlockedDevicesList.appendChild(row);
    });
  }

  async function refreshAdmin() {
    // One request instead of six — the backend now reads the Log
    // sheet once and returns everything the dashboard needs together.
    // Falls back to the old six-separate-calls behavior automatically
    // if adminDashboard isn't reachable for some reason (each render
    // function still knows how to fetch its own data when called with
    // no argument).
    const data = await adminFetch("adminDashboard");
    if (!data) {
      renderAdminPresence();
      renderApprovalQueue();
      renderRejectedQueue();
      renderAdminRoster();
      renderFlags();
      renderAuditLog();
      renderContentStats();
      renderBlockedDevices();
      renderFeedbackAdmin();
      return;
    }
    renderAdminPresence(data.online);
    renderApprovalQueue(data.queue);
    renderRejectedQueue(data.rejectedQueue);
    renderAdminRoster(data.people);
    renderFlags(data.flags);
    renderAuditLog(data.log);
    renderContentStats(data.stats);
    renderBlockedDevices(data.devices);
    renderSummaryStrip(data.online, data.flags, data.queue, data.bandwidth);
    renderFeedbackAdmin(data.feedback);
  }

  async function renderContentStats(preloaded) {
    const data = preloaded ? { ok: true, stats: preloaded } : await adminFetch("contentStats");
    if (!data) return;
    const stats = (data.stats || []).slice(0, 15);
    adminContentStatsList.innerHTML = "";
    if (!stats.length) {
      adminContentStatsList.innerHTML = `<p class="admin__empty">No views logged yet</p>`;
      return;
    }
    stats.forEach((s) => {
      const mins = Math.round((s.seconds || 0) / 60);
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${s.file}</span>
          <span class="admin__presence-meta">${s.views} views · ${s.downloads} downloads · ${s.distinctViewers} people · ${mins}m total</span>
        </div>`;
      adminContentStatsList.appendChild(row);
    });
  }

  async function renderFeedbackAdmin(preloaded) {
    const data = preloaded ? { ok: true, ...preloaded } : await adminFetch("feedbackList");
    if (!data) return;
    const entries = data.entries || [];
    adminFeedbackAvg.textContent = data.averageRating ? `${data.averageRating} / 5 average (${data.count} response${data.count === 1 ? "" : "s"})` : `No ratings yet`;
    adminFeedbackList.innerHTML = "";
    if (!entries.length) {
      adminFeedbackList.innerHTML = `<p class="admin__empty">No feedback yet</p>`;
      return;
    }
    entries.slice(0, 30).forEach((f) => {
      const when = f.timestamp ? new Date(f.timestamp).toLocaleString() : "";
      const stars = f.rating ? "★".repeat(f.rating) + "☆".repeat(5 - f.rating) : "—";
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${f.name || "Anonymous"} <span class="admin__feedback-stars">${stars}</span></span>
          <span class="admin__presence-meta">${f.email ? f.email + " · " : ""}${f.improvements ? f.improvements + " · " : ""}${when}</span>
          ${f.suggestion ? `<p class="admin__feedback-suggestion">${f.suggestion}</p>` : ""}
        </div>`;
      adminFeedbackList.appendChild(row);
    });
  }

  // ── Scan Backblaze for new files ("scan and confirm") ────────────
  // Lists everything currently in the bucket, compares it against the
  // Catalog sheet, and shows only what's genuinely new — nothing gets
  // added to the live site until you review each one here and confirm.
  // A wrong guess at which subject/folder a file belongs to would put
  // it in front of students immediately, which is exactly why nothing
  // here is silent or automatic.
  let scanTimerInterval = null;

  async function onScanBackblaze() {
    adminScanBtn.disabled = true;
    adminScanResults.innerHTML = "";
    adminScanProgress.classList.remove("hidden");
    const startedAt = Date.now();
    adminScanTimer.textContent = "Scanning… 0.0s";
    scanTimerInterval = setInterval(() => {
      adminScanTimer.textContent = `Scanning… ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    }, 100);

    const data = await adminFetch("scanBackblaze");

    clearInterval(scanTimerInterval);
    scanTimerInterval = null;
    adminScanProgress.classList.add("hidden");
    adminScanBtn.disabled = false;

    if (!data) {
      adminScanResults.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
      return;
    }
    if (data.error) {
      adminScanResults.innerHTML = `<p class="admin__empty">Scan failed: ${data.error}</p>`;
      return;
    }
    renderScanResults(data);
  }

  function renderScanResults(data) {
    const newFiles = data.newFiles || [];
    const unrecognized = data.unrecognized || [];
    adminScanResults.innerHTML = "";

    const summary = el("p", "admin-scan-summary",
      `Scanned ${data.totalInBucket || 0} file${data.totalInBucket === 1 ? "" : "s"} in the bucket — ${newFiles.length} new.`);
    adminScanResults.appendChild(summary);

    if (!newFiles.length && !unrecognized.length) {
      adminScanResults.appendChild(el("p", "admin__empty", "Nothing new — the catalog is already up to date."));
      return;
    }

    if (newFiles.length) {
      const list = el("div", "admin-scan-list");
      const subjectOptions = SITE_CONFIG.subjects.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");

      newFiles.forEach((item, idx) => {
        const row = el("div", "admin-scan-row");
        row.innerHTML = `
          <input type="checkbox" class="admin__roster-checkbox" data-scan-check checked>
          <div class="admin-scan-row__fields">
            <select class="admin-scan-row__subject" data-field="subjectId">${subjectOptions}</select>
            <input type="text" class="admin-scan-row__input" data-field="folderName" value="${item.folderName}" placeholder="Folder / chapter name">
            <input type="text" class="admin-scan-row__input" data-field="displayName" value="${item.displayName}" placeholder="Display name">
          </div>
          <span class="admin-scan-row__path">${item.filePath}</span>
        `;
        row.querySelector('[data-field="subjectId"]').value = item.subjectId;
        list.appendChild(row);
        row.dataset.idx = String(idx);
      });
      adminScanResults.appendChild(list);

      const confirmBtn = el("button", "admin__nav-btn", "Confirm selected");
      confirmBtn.type = "button";
      confirmBtn.addEventListener("click", () => onConfirmScanResults(list, newFiles));
      adminScanResults.appendChild(confirmBtn);
    }

    if (unrecognized.length) {
      const uLabel = el("p", "admin__section-title", "Couldn't figure out where these belong — fix the path in Backblaze and re-scan");
      adminScanResults.appendChild(uLabel);
      unrecognized.forEach((u) => {
        adminScanResults.appendChild(el("p", "admin-scan-row__path", u.path));
      });
    }
  }

  async function onConfirmScanResults(list, newFiles) {
    const items = [];
    list.querySelectorAll(".admin-scan-row").forEach((row) => {
      if (!row.querySelector("[data-scan-check]").checked) return;
      const idx = Number(row.dataset.idx);
      const original = newFiles[idx];
      items.push({
        subjectId: row.querySelector('[data-field="subjectId"]').value,
        folderName: row.querySelector('[data-field="folderName"]').value.trim(),
        fileName: original.fileName,
        filePath: original.filePath,
        displayName: row.querySelector('[data-field="displayName"]').value.trim() || original.displayName
      });
    });
    if (!items.length) return;

    const endpoint = SITE_CONFIG.logging && SITE_CONFIG.logging.endpoint;
    if (!endpoint) return;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ type: "confirmCatalogAdditions", key: adminApiToken, items })
      });
      const data = await res.json();
      if (data && data.ok) {
        showToast(`Added ${data.added} file${data.added === 1 ? "" : "s"} to the catalog.`);
        adminScanResults.innerHTML = "";
      } else {
        showToast("Couldn't save — check the admin key and try again.", true);
      }
    } catch {
      showToast("Couldn't reach the sheet — check your connection and try again.", true);
    }
  }

  let selectedQueueNames = new Set();

  async function renderApprovalQueue(preloaded) {
    const data = preloaded ? { ok: true, queue: preloaded } : await adminFetch("unauthorizedQueue");
    const queue = (data && data.queue) || [];
    adminApprovalList.innerHTML = "";
    selectedQueueNames.clear();
    updateQueueBulkBtns();

    if (!data) {
      adminApprovalList.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
      return;
    }
    if (!queue.length) {
      adminApprovalList.innerHTML = `<p class="admin__empty">No pending attempts</p>`;
      return;
    }

    queue.forEach((q) => {
      const when = q.lastAttempt ? new Date(q.lastAttempt).toLocaleString() : "";
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <input type="checkbox" class="admin__roster-checkbox" data-queue-check>
        <div class="admin__presence-info">
          <span class="admin__presence-name">${q.name}</span>
          <span class="admin__presence-meta">${q.count} attempt${q.count === 1 ? "" : "s"} · last ${when}</span>
        </div>
        <div class="admin__presence-actions">
          <button type="button" class="admin__presence-btn" data-action="approve">Approve</button>
          <button type="button" class="admin__presence-btn admin__presence-btn--danger" data-action="reject">Reject</button>
        </div>`;
      row.querySelector('[data-queue-check]').addEventListener("change", (e) => {
        if (e.target.checked) selectedQueueNames.add(q.name);
        else selectedQueueNames.delete(q.name);
        updateQueueBulkBtns();
      });
      row.querySelector('[data-action="approve"]').addEventListener("click", async () => {
        await adminFetch("approveName", { name: q.name });
        renderApprovalQueue();
      });
      row.querySelector('[data-action="reject"]').addEventListener("click", async () => {
        await adminFetch("rejectName", { name: q.name });
        renderApprovalQueue();
        renderRejectedQueue();
      });
      adminApprovalList.appendChild(row);
    });
  }

  function updateQueueBulkBtns() {
    const n = selectedQueueNames.size;
    adminApproveSelectedBtn.textContent = `Approve selected (${n})`;
    adminRejectSelectedBtn.textContent = `Reject selected (${n})`;
    adminApproveSelectedBtn.disabled = n === 0;
    adminRejectSelectedBtn.disabled = n === 0;
  }

  async function onApproveSelected() {
    const names = Array.from(selectedQueueNames);
    if (!names.length) return;
    await Promise.all(names.map((name) => adminFetch("approveName", { name })));
    renderApprovalQueue();
  }

  async function onRejectSelected() {
    const names = Array.from(selectedQueueNames);
    if (!names.length) return;
    if (!(await showConfirm(`Reject ${names.length} pending name${names.length === 1 ? "" : "s"}? They'll stop showing up here — this doesn't block their device or name, just clears this queue entry.`))) return;
    await Promise.all(names.map((name) => adminFetch("rejectName", { name })));
    renderApprovalQueue();
    renderRejectedQueue();
  }

  async function renderRejectedQueue(preloaded) {
    const data = preloaded ? { ok: true, queue: preloaded } : await adminFetch("rejectedQueue");
    if (!data) return;
    const queue = data.queue || [];
    adminRejectedList.innerHTML = "";
    if (!queue.length) {
      adminRejectedList.innerHTML = `<p class="admin__empty">Nothing rejected</p>`;
      return;
    }
    queue.forEach((q) => {
      const when = q.rejectedAt ? new Date(q.rejectedAt).toLocaleString() : "";
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${q.name}</span>
          <span class="admin__presence-meta">Rejected ${when}</span>
        </div>
        <div class="admin__presence-actions">
          <button type="button" class="admin__presence-btn" data-action="restore">Restore</button>
        </div>`;
      row.querySelector('[data-action="restore"]').addEventListener("click", async () => {
        await adminFetch("unrejectName", { name: q.name });
        renderRejectedQueue();
        renderApprovalQueue();
      });
      adminRejectedList.appendChild(row);
    });
  }

  async function onAdminAddName() {
    const name = adminAddNameInput.value.trim();
    if (!name) return;
    await adminFetch("approveName", { name });
    adminAddNameInput.value = "";
    renderApprovalQueue();
  }

  function updateMergeBtn() {
    const n = selectedForMerge.size;
    adminMergeBtn.textContent = `Merge selected (${n})`;
    adminMergeBtn.disabled = n !== 2;
    adminSuspendSelectedBtn.textContent = `Suspend selected (${n})`;
    adminSuspendSelectedBtn.disabled = n === 0;
  }

  async function onMergeSelected() {
    if (selectedForMerge.size !== 2) return;
    const [a, b] = Array.from(selectedForMerge);
    const primary = await showPrompt(`Merging "${a}" and "${b}" as one person. Which name should show on the roster? (type it exactly, or leave as-is)`, a);
    if (!primary) return;
    const alias = primary === a ? b : a;
    await adminFetch("mergeIdentities", { primary, alias });
    selectedForMerge.clear();
    updateMergeBtn();
    renderAdminRoster();
  }

  async function onSuspendSelected() {
    const names = Array.from(selectedForMerge);
    if (!names.length) return;
    if (!(await showConfirm(`Suspend ${names.length} selected ${names.length === 1 ? "person" : "people"}? This blocks every device and name each of them has ever used, and signs them out right now if online.`))) return;
    await Promise.all(names.map((name) => adminFetch("suspendIdentity", { name })));
    selectedForMerge.clear();
    updateMergeBtn();
    renderAdminRoster();
  }

  async function onToggleSuspend(name, currentlySuspended) {
    const verb = currentlySuspended ? "unsuspend" : "suspend";
    if (!(await showConfirm(`${currentlySuspended ? "Unsuspend" : "Suspend"} "${name}"?${currentlySuspended ? "" : " This also blocks every device and name they've ever used, and signs them out right now if online."}`))) return;
    await adminFetch(currentlySuspended ? "unsuspendIdentity" : "suspendIdentity", { name });
    renderAdminRoster();
  }

  async function onSetExpiry(name, currentExpiresAt) {
    const current = currentExpiresAt ? new Date(currentExpiresAt).toISOString().slice(0, 10) : "";
    const input = await showPrompt(`Access expiry date for "${name}" (YYYY-MM-DD). Leave blank to remove expiry.`, current);
    if (input === null) return; // cancelled
    await adminFetch("setExpiry", { name, date: input.trim() });
    renderAdminRoster();
  }

  async function renderFlags(preloaded) {
    const data = preloaded ? { ok: true, flags: preloaded } : await adminFetch("flags");
    if (!data) {
      adminFlagsList.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
      return;
    }
    const { deviceCycling = [], rapidRepeat = [], bulkView = [] } = data.flags || {};
    adminFlagsList.innerHTML = "";

    const items = [
      ...deviceCycling.map((f) => ({
        label: `One device used ${f.names.length} different names: ${f.names.join(", ")}`,
        when: f.when,
        names: f.names
      })),
      ...rapidRepeat.map((f) => ({
        label: `"${f.name}" attempted login ${f.count} times, 5+ within a minute`,
        when: f.when,
        names: [f.name]
      })),
      ...bulkView.map((f) => ({
        label: `${f.name} opened/downloaded ${f.count} files, 8+ within 5 minutes`,
        when: f.when,
        names: [f.name]
      }))
    ].sort((a, b) => new Date(b.when) - new Date(a.when));

    if (!items.length) {
      adminFlagsList.innerHTML = `<p class="admin__empty">Nothing flagged</p>`;
      return;
    }

    items.forEach((f) => {
      const row = el("div", "admin__presence-row");
      const actionsHtml = f.names.map((n) =>
        `<button type="button" class="admin__presence-btn admin__presence-btn--danger" data-suspend="${n.replace(/"/g, "&quot;")}">Suspend${f.names.length > 1 ? ` "${n}"` : ""}</button>`
      ).join("");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${f.label}</span>
          <span class="admin__presence-meta">${new Date(f.when).toLocaleString()}</span>
        </div>
        <div class="admin__presence-actions">${actionsHtml}</div>`;
      row.querySelectorAll("[data-suspend]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const name = btn.getAttribute("data-suspend");
          if (!(await showConfirm(`Suspend "${name}"? This blocks every device and name they've used, and signs them out right now if online.`))) return;
          await adminFetch("suspendIdentity", { name });
          showToast(`Suspended "${name}".`);
          renderFlags();
        });
      });
      adminFlagsList.appendChild(row);
    });
  }

  async function onArchiveOldLogs() {
    const daysStr = await showPrompt("Move log rows older than how many days into a separate archive tab? (nothing is deleted, just moved out of the live sheet)", "90");
    if (daysStr === null) return;
    const days = Number(daysStr);
    if (!days || days < 1) { showToast("Enter a number of days.", true); return; }
    if (!(await showConfirm(`Archive everything older than ${days} days? Roster totals will drop for anyone whose activity is entirely in that window — their history moves to a LogArchive tab, it isn't deleted.`))) return;
    const data = await adminFetch("archiveOldLogs", { days });
    if (!data) { showToast("Couldn't reach the sheet.", true); return; }
    showToast(`Archived ${data.result.archived} rows, ${data.result.kept} left in the live sheet.`);
    refreshAdmin();
  }

  async function onBroadcastMessage() {
    const message = await showPrompt("Message to send to everyone online right now:");
    if (!message || !message.trim()) return;
    const data = await adminFetch("presenceLive");
    const online = (data && data.online) || [];
    await Promise.all(online.map((p) => adminFetch("sendMessage", { sessionId: p.sessionId, message: message.trim() })));
    showToast(`Sent to ${online.length} online session${online.length === 1 ? "" : "s"}.`);
  }

  async function renderAuditLog(preloaded) {
    const data = preloaded ? { ok: true, log: preloaded } : await adminFetch("adminActionLog");
    if (!data) return;
    const log = data.log || [];
    adminAuditList.innerHTML = "";
    if (!log.length) {
      adminAuditList.innerHTML = `<p class="admin__empty">No admin actions yet</p>`;
      return;
    }
    log.slice(0, 30).forEach((entry) => {
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${entry.action}${entry.detail ? " — " + entry.detail : ""}</span>
          <span class="admin__presence-meta">${new Date(entry.timestamp).toLocaleString()}</span>
        </div>`;
      adminAuditList.appendChild(row);
    });
  }

  function onExportCsv() {
    if (!lastRosterPeople.length) return;
    const headers = ["Name", "Aliases", "Suspended", "ExpiresAt", "LastSeen", "SessionCount", "TotalSessionMinutes", "TotalViewMinutes", "LoginCount", "UnauthorizedCount"];
    const rows = lastRosterPeople.map((p) => [
      p.name,
      (p.aliases || []).join("; "),
      p.suspended ? "yes" : "no",
      p.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 10) : "",
      p.lastSeen ? new Date(p.lastSeen).toISOString() : "",
      p.sessionCount,
      Math.round((p.totalSessionSeconds || 0) / 60),
      Math.round((p.totalViewSeconds || 0) / 60),
      p.loginCount,
      p.unauthorizedCount
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `roster-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function renderAdminPresence(preloaded) {
    const data = preloaded ? { ok: true, online: preloaded } : await adminFetch("presenceLive");
    const online = (data && data.online) || [];
    adminPresenceList.innerHTML = "";

    if (!data) {
      adminPresenceList.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
      return;
    }
    if (!online.length) {
      adminPresenceList.innerHTML = `<p class="admin__empty">Nobody online right now</p>`;
      return;
    }

    online.forEach((person) => {
      const startedAt = new Date(person.sessionStart).getTime();
      const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <span class="admin__presence-dot"></span>
        <div class="admin__presence-info">
          <span class="admin__presence-name">${person.name}</span>
          <span class="admin__presence-meta">online ${mins} min · ${person.currentPage || "home"}</span>
        </div>
        <div class="admin__presence-actions">
          <button type="button" class="admin__presence-btn" data-action="message">Message</button>
          <button type="button" class="admin__presence-btn admin__presence-btn--danger" data-action="logout">Log out</button>
        </div>`;
      row.addEventListener("click", () => openAdminDetail(person.name));
      row.querySelector('[data-action="message"]').addEventListener("click", (e) => {
        e.stopPropagation();
        sendAdminMessage(person.sessionId, person.name);
      });
      row.querySelector('[data-action="logout"]').addEventListener("click", (e) => {
        e.stopPropagation();
        forceLogoutUser(person.sessionId, person.name);
      });
      adminPresenceList.appendChild(row);
    });
  }

  async function sendAdminMessage(sessionId, name) {
    const message = await showPrompt(`Message to send ${name} (pops up on their screen within ~45s):`);
    if (!message) return;
    await adminFetch("sendMessage", { sessionId, message });
  }

  async function forceLogoutUser(sessionId, name) {
    if (!(await showConfirm(`Sign ${name} out now? They'll see a notice and be returned to the login screen.`))) return;
    await adminFetch("forceLogout", { sessionId });
  }

  async function renderAdminRoster(preloadedOrSkip) {
    if (Array.isArray(preloadedOrSkip)) {
      lastRosterPeople = preloadedOrSkip;
    } else if (!preloadedOrSkip) {
      adminRosterList.innerHTML = `<p class="admin__loading">Loading…</p>`;
      const data = await adminFetch("adminSummary");
      if (!data) {
        adminRosterList.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
        return;
      }
      lastRosterPeople = data.people || [];
    }
    // preloadedOrSkip === true (search-box re-filter): fall through
    // and reuse whatever's already in lastRosterPeople, no fetch.

    const query = adminRosterSearch.value.trim().toLowerCase();
    const people = query
      ? lastRosterPeople.filter((p) => {
          const haystack = [p.name, ...(p.aliases || [])].join(" ").toLowerCase();
          return haystack.includes(query);
        })
      : lastRosterPeople;

    adminRosterList.innerHTML = "";

    if (!lastRosterPeople.length) {
      adminRosterList.innerHTML = `<p class="admin__empty">No activity logged yet</p>`;
      return;
    }
    if (!people.length) {
      adminRosterList.innerHTML = `<p class="admin__empty">No one matches "${query}"</p>`;
      return;
    }

    people.forEach((p) => {
      const row = el("div", "admin__roster-row");
      row.tabIndex = 0;
      const lastSeen = p.lastSeen ? new Date(p.lastSeen).toLocaleString() : "—";
      const totalMins = Math.round((p.totalSessionSeconds || 0) / 60);
      const akaText = p.aliases && p.aliases.length ? ` <span class="admin__roster-aka">aka ${p.aliases.join(", ")}</span>` : "";
      const expiryLabel = p.expiresAt ? "Expires " + new Date(p.expiresAt).toLocaleDateString() : "Set expiry…";
      const actionLabels = { approveName: "Approved", rejectName: "Rejected", suspendIdentity: "Suspended", unsuspendIdentity: "Unsuspended", setExpiry: "Expiry set" };
      const lastActionText = p.lastAction
        ? `${actionLabels[p.lastAction.action] || p.lastAction.action} ${new Date(p.lastAction.timestamp).toLocaleDateString()}`
        : "No admin action yet";
      row.innerHTML = `
        <input type="checkbox" class="admin__roster-checkbox" ${selectedForMerge.has(p.name) ? "checked" : ""}>
        <div class="admin__roster-name">${p.name}${akaText}${p.suspended ? ' <span class="admin__roster-badge">suspended</span>' : ""}</div>
        <div class="admin__roster-stat">${totalMins}m total</div>
        <div class="admin__roster-stat">${p.sessionCount} session${p.sessionCount === 1 ? "" : "s"}</div>
        <div class="admin__roster-stat">${p.filesTouched}/${p.totalKnownFiles} files</div>
        <div class="admin__roster-stat admin__roster-lastseen">Last seen ${lastSeen}</div>
        <div class="admin__roster-stat admin__roster-lastaction">${lastActionText}</div>
        <div class="admin__row-menu">
          <button type="button" class="admin__row-menu-btn" data-action="menu-toggle" aria-label="Actions">\u22EF</button>
          <div class="admin__row-menu-dropdown hidden">
            <button type="button" class="admin__row-menu-item admin__row-menu-item--danger" data-action="suspend">${p.suspended ? "Unsuspend" : "Suspend"}</button>
            <button type="button" class="admin__row-menu-item" data-action="expiry">${expiryLabel}</button>
          </div>
        </div>`;

      row.addEventListener("click", () => openAdminDetail(p.name));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") openAdminDetail(p.name); });

      row.querySelector(".admin__roster-checkbox").addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.checked) selectedForMerge.add(p.name);
        else selectedForMerge.delete(p.name);
        updateMergeBtn();
      });

      const dropdown = row.querySelector(".admin__row-menu-dropdown");
      row.querySelector('[data-action="menu-toggle"]').addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = !dropdown.classList.contains("hidden");
        closeAllRowMenus();
        if (!wasOpen) dropdown.classList.remove("hidden");
      });
      row.querySelector('[data-action="suspend"]').addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllRowMenus();
        onToggleSuspend(p.name, !!p.suspended);
      });
      row.querySelector('[data-action="expiry"]').addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllRowMenus();
        onSetExpiry(p.name, p.expiresAt);
      });

      adminRosterList.appendChild(row);
    });
  }

  // Closes any open "⋯" dropdown — called before opening a new one,
  // and on any outside click, so at most one is ever open at a time.
  function closeAllRowMenus() {
    $$(".admin__row-menu-dropdown").forEach((d) => d.classList.add("hidden"));
  }
  document.addEventListener("click", closeAllRowMenus);

  async function openAdminDetail(name) {
    adminDetail.classList.remove("hidden");
    adminDetailName.textContent = name;
    adminDetailBody.innerHTML = `<p class="admin__loading">Loading…</p>`;
    const data = await adminFetch("personDetail", { name });
    if (!data) {
      adminDetailBody.innerHTML = `<p class="admin__empty">Couldn't reach the sheet — check the admin key.</p>`;
      return;
    }
    renderAdminDetail(data.events || [], data.totals || {});
  }

  function closeAdminDetail() {
    adminDetail.classList.add("hidden");
  }

  function renderAdminDetail(events, totals) {
    const subjectMap = getFileSubjectMap();
    const subjectSeconds = {};
    const fileSeconds = {};
    const recentRows = events.slice(0, 40);

    // Bars below still need to be built from view_end events (they
    // break time down per-file/subject, which the backend doesn't
    // pre-aggregate). The top summary numbers, though, come straight
    // from `totals` — computed backend-side the same way the roster
    // computes them, including an estimate for a session/view that's
    // still in progress right now. Recomputing them here from only
    // "_end" events (the old approach) is exactly why this panel used
    // to show 0m/0/0 for someone currently online.
    const totalViewSeconds = totals.totalViewSeconds || 0;
    const totalSessionSeconds = totals.totalSessionSeconds || 0;
    const sessionCount = totals.sessionCount || 0;

    events.forEach((ev) => {
      if (ev.type === "view_end" && ev.duration) {
        fileSeconds[ev.detail] = (fileSeconds[ev.detail] || 0) + ev.duration;
        const mapped = subjectMap[ev.detail];
        const subj = mapped ? mapped.subject : "Other";
        subjectSeconds[subj] = (subjectSeconds[subj] || 0) + ev.duration;
      }
    });

    const barRows = (obj, unit) =>
      Object.keys(obj)
        .sort((a, b) => obj[b] - obj[a])
        .slice(0, 10)
        .map((k) => `<div class="admin__bar-row"><span class="admin__bar-label">${k}</span><span class="admin__bar-value">${Math.round(obj[k] / 60)}${unit}</span></div>`)
        .join("") || `<p class="admin__empty">No PDF views yet</p>`;

    const timeline = recentRows.map((ev) => {
      const t = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : "";
      const extra = ev.duration ? ` · ${Math.round(ev.duration)}s` : "";
      return `<div class="admin__timeline-row">
        <span class="admin__timeline-time">${t}</span>
        <span class="admin__timeline-type">${ev.type}</span>
        <span class="admin__timeline-detail">${ev.detail || ""}${extra}</span>
      </div>`;
    }).join("") || `<p class="admin__empty">No activity yet</p>`;

    adminDetailBody.innerHTML = `
      <div class="admin__detail-summary">
        <div class="admin__detail-stat"><span class="admin__detail-num">${Math.round(totalSessionSeconds / 60)}m</span><span class="admin__detail-label">total on site</span></div>
        <div class="admin__detail-stat"><span class="admin__detail-num">${Math.round(totalViewSeconds / 60)}m</span><span class="admin__detail-label">inside PDFs</span></div>
        <div class="admin__detail-stat"><span class="admin__detail-num">${sessionCount}</span><span class="admin__detail-label">sessions</span></div>
      </div>
      <p class="admin__detail-heading">Time by subject</p>
      <div class="admin__bars">${barRows(subjectSeconds, "m")}</div>
      <p class="admin__detail-heading">Most-viewed files</p>
      <div class="admin__bars">${barRows(fileSeconds, "m")}</div>
      <p class="admin__detail-heading">Recent activity</p>
      <div class="admin__timeline">${timeline}</div>
    `;
  }

  // ── Utility ────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // ── Go ─────────────────────────────────────────────────
  init();
})();
