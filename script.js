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
  function makePdfLoadingTask(path) {
    const task = { onProgress: null };
    task.promise = ensurePdfToken().then((token) => {
      const realTask = pdfjsLib.getDocument(pdfWorkerUrl(path, token));
      realTask.onProgress = (p) => { if (task.onProgress) task.onProgress(p); };
      return realTask.promise;
    }).catch((err) => {
      if (pdfLoadingTasks.get(path) === task) pdfLoadingTasks.delete(path);
      throw err;
    });
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
  const gateBtn     = $(".gate__btn");
  const gateError   = $("#gateError");
  const gateField   = $(".gate__field");

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

  // ── Concurrent-session lock ───────────────────────────────
  // True if this name (or any alias linked to it from the admin
  // dashboard's merge tool) is already active in another session
  // right now. Fails open (false) on any network error — a hiccup
  // here should never lock out a legitimate solo login.
  async function isNameActive(name) {
    const remote = await fetchLoginCheck(name);
    return remote.active;
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
  function saveSession(name) {
    sessionStorage.setItem("c12_name", JSON.stringify({ name, ts: Date.now() }));
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
    logoutBtn.addEventListener("click", () => performLogout("logout"));
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
    adminTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".admin__tab");
      if (btn) switchAdminTab(btn.dataset.tab);
    });
    adminDetailClose.addEventListener("click", closeAdminDetail);
    adminDetailOverlay.addEventListener("click", closeAdminDetail);

    viewerClose.addEventListener("click", closeViewer);
    viewerOverlay.addEventListener("click", closeViewer);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncViewerViewport);
      window.visualViewport.addEventListener("scroll", syncViewerViewport);
    }
    $("#viewerZoomIn").addEventListener("click", zoomIn);
    $("#viewerZoomOut").addEventListener("click", zoomOut);
    viewerPages.addEventListener("touchstart", onViewerTouchStart, { passive: true });
    viewerPages.addEventListener("touchmove", onViewerTouchMove, { passive: false });
    viewerPages.addEventListener("touchend", onViewerTouchEnd, { passive: true });
    viewerPages.addEventListener("touchcancel", onViewerTouchEnd, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeViewer();

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

      if (!(await isAuthorized(name))) {
        logEvent("login", name, "unauthorized", trace);
        // Framed as "not yet approved" rather than a flat rejection —
        // this used to read like a locked door ("you're not
        // authorized"), which doesn't fit a free, word-of-mouth
        // resource where you WANT people to ask for access. Points
        // at the WhatsApp/Email links already sitting right below the
        // form instead of duplicating contact info here.
        showGateError("You're not on the approved list yet — tap WhatsApp or Email below to request access.");
        return;
      }

      // One active session per identity at a time — checked after
      // suspended/authorized so a blocked name never reaches this far.
      // A reload or reopened tab by the same person can momentarily
      // trip this until their old session goes stale (~90s) — a known
      // trade-off for now.
      if (await isNameActive(name)) {
        logEvent("login", name, "concurrent_blocked", trace);
        showGateError("This name is already logged in on another device right now. Please wait a minute and try again.");
        return;
      }

      hideGateError();
      saveSession(name);
      logEvent("login", name, "authorized", trace);
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
  }

  function showApp(name) {
    currentName = name;
    sessionId = makeId();
    sessionStart = Date.now();
    app.classList.remove("hidden");
    greeting.textContent = `Hi, ${name}`;
    logEvent("session_start", name, "");
    startHeartbeat();
    ensurePdfToken(); // kick off in the background — don't make the very first thumbnail wait on it
    nav("home");
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
      return pdf.getPage(1);
    }).then((page) => {
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
      if (reason === "suspended") {
        statusText.textContent = (SITE_CONFIG.suspended && SITE_CONFIG.suspended.message) || "You've lost access to this content.";
      } else if (reason === "unauthorized") {
        statusText.textContent = "You're not authorized to view this file.";
      } else {
        statusText.textContent = "Couldn't load this PDF. Please try again.";
      }
      track.remove();
    });
  }

  function renderAllPages(token) {
    if (!pagesInner) return Promise.resolve();
    pagesInner.querySelectorAll(".viewer__page").forEach((c) => c.remove());
    const pdf = currentPdf;
    if (!pdf) return Promise.resolve();

    // Rendered at devicePixelRatio so the base view is sharp on
    // retina/high-DPI phones — this alone fixes a lot of perceived
    // "blurriness" independent of zoom. The zoom buttons below then
    // ask pdf.js to redraw at a genuinely higher resolution rather
    // than stretching this canvas, which is what pinch-zoom was doing
    // before (and why it went pixelated).
    const dpr = window.devicePixelRatio || 1;

    // Stamps a faint, repeated, diagonal "name · date" watermark over
    // a rendered PDF canvas. This does NOT stop screenshots or screen
    // recording — nothing client-side can. What it does do is make
    // any leaked page traceable back to whoever viewed it, which is
    // the realistic goal for paid material shared as images.
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

    const renderPage = (pageNum) => {
      if (token !== viewerLoadToken) return Promise.resolve();
      return pdf.getPage(pageNum).then((page) => {
        if (token !== viewerLoadToken) return;
        const displayWidth = Math.min(viewerPages.clientWidth - 32, 900) * viewerZoom;
        const unscaledViewport = page.getViewport({ scale: 1 });
        const renderScale = (displayWidth / unscaledViewport.width) * dpr;
        const viewport = page.getViewport({ scale: renderScale });

        const canvas = document.createElement("canvas");
        canvas.className = "viewer__page";
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        pagesInner.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        return page.render({ canvasContext: ctx, viewport }).promise.then(() => {
          drawWatermark(ctx, canvas);
        });
      });
    };

    // Rendered sequentially (not all at once) so a long document
    // doesn't stall the browser trying to render every page up front.
    let chain = Promise.resolve();
    for (let i = 1; i <= pdf.numPages; i++) {
      chain = chain.then(() => renderPage(i));
    }
    return chain;
  }

  function updateZoomLabel() {
    const label = $("#viewerZoomLabel");
    if (label) label.textContent = `${Math.round(viewerZoom * 100)}%`;
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function setZoom(next) {
    next = Math.round(clampZoom(next) * 100) / 100;
    if (!currentPdf || next === viewerZoom) return;
    viewerZoom = next;
    updateZoomLabel();
    const myToken = ++viewerLoadToken; // supersedes any render still in flight from a prior zoom click

    // renderAllPages wipes every page canvas before redrawing them at
    // the new size — and the instant they're removed, the container's
    // scroll position collapses to 0. Left alone, that meant zooming
    // while reading (say) page 6 always dumped you back on page 1.
    // Capture how far down you were as a fraction of the scrollable
    // height *before* the wipe, then re-apply that same fraction once
    // the new (differently-sized) pages are back in — since every page
    // scales by the same zoom factor, the fraction lands you back on
    // the same page at roughly the same spot within it.
    const maxScrollBefore = viewerPages.scrollHeight - viewerPages.clientHeight;
    const scrollRatio = maxScrollBefore > 0 ? viewerPages.scrollTop / maxScrollBefore : 0;

    renderAllPages(myToken).then(() => {
      if (myToken !== viewerLoadToken) return;
      const maxScrollAfter = viewerPages.scrollHeight - viewerPages.clientHeight;
      viewerPages.scrollTop = maxScrollAfter > 0 ? scrollRatio * maxScrollAfter : 0;
    });
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

  function touchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onViewerTouchStart(e) {
    if (e.touches.length === 2 && currentPdf) {
      pinchStartDist = touchDistance(e.touches);
      pinchStartZoom = viewerZoom;
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
      if (pagesInner) pagesInner.style.transform = "";
      if (pinchLiveZoom !== null) setZoom(pinchLiveZoom);
      pinchLiveZoom = null;
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

  function renderSummaryStrip(online, flags, queue) {
    const flagCount = (flags.deviceCycling || []).length + (flags.rapidRepeat || []).length + (flags.bulkView || []).length;
    const cards = [
      { num: online.length, label: "Online now" },
      { num: flagCount, label: "Flagged", alert: flagCount > 0 },
      { num: queue.length, label: "Pending approval", alert: queue.length > 0 }
    ];
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
      renderAdminRoster();
      renderFlags();
      renderAuditLog();
      renderContentStats();
      renderBlockedDevices();
      return;
    }
    renderAdminPresence(data.online);
    renderApprovalQueue(data.queue);
    renderAdminRoster(data.people);
    renderFlags(data.flags);
    renderAuditLog(data.log);
    renderContentStats(data.stats);
    renderBlockedDevices(data.devices);
    renderSummaryStrip(data.online, data.flags, data.queue);
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
        when: f.when
      })),
      ...rapidRepeat.map((f) => ({
        label: `"${f.name}" attempted login ${f.count} times, 5+ within a minute`,
        when: f.when
      })),
      ...bulkView.map((f) => ({
        label: `${f.name} opened/downloaded ${f.count} files, 8+ within 5 minutes`,
        when: f.when
      }))
    ].sort((a, b) => new Date(b.when) - new Date(a.when));

    if (!items.length) {
      adminFlagsList.innerHTML = `<p class="admin__empty">Nothing flagged</p>`;
      return;
    }

    items.forEach((f) => {
      const row = el("div", "admin__presence-row");
      row.innerHTML = `
        <div class="admin__presence-info">
          <span class="admin__presence-name">${f.label}</span>
          <span class="admin__presence-meta">${new Date(f.when).toLocaleString()}</span>
        </div>`;
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
      row.innerHTML = `
        <input type="checkbox" class="admin__roster-checkbox" ${selectedForMerge.has(p.name) ? "checked" : ""}>
        <div class="admin__roster-name">${p.name}${akaText}${p.suspended ? ' <span class="admin__roster-badge">suspended</span>' : ""}</div>
        <div class="admin__roster-stat">${totalMins}m total</div>
        <div class="admin__roster-stat">${p.sessionCount} session${p.sessionCount === 1 ? "" : "s"}</div>
        <div class="admin__roster-stat">${p.filesTouched}/${p.totalKnownFiles} files</div>
        <div class="admin__roster-stat admin__roster-lastseen">Last seen ${lastSeen}</div>
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
