/**
 * CLASS 12 STUDY PORTAL — ACTIVITY LOGGER + AUTO DEVICE BLOCK + ADMIN
 * ------------------------------------------------------------
 * Receives login / view / navigation / session events from script.js,
 * and serves the admin dashboard (roster summary, live "who's online"
 * presence, per-person detail, approval queue, and identity/suspension
 * management) — all read fresh from this sheet on every request.
 *
 * ─────────────────────────────────────────────────────────────
 * IDENTITY SYSTEM
 * ─────────────────────────────────────────────────────────────
 * Two sheet tabs:
 *   - "Identities"  — one row per real person: IdentityId | CanonicalName | Status | CreatedAt
 *   - "Aliases"     — one row per known name variant: NormalizedAlias | IdentityId
 *
 * ─────────────────────────────────────────────────────────────
 * LIVE ACCESS LIST + LIVE SUSPENSION
 * ─────────────────────────────────────────────────────────────
 *   - "AccessList"     — NameHash | Name | AddedAt        (?action=accessList)
 *   - "SuspendedNames" — NameHash | Name | SuspendedAt     (?action=suspendedNames)
 *
 * ─────────────────────────────────────────────────────────────
 * CONCURRENT-SESSION LOCK
 * ─────────────────────────────────────────────────────────────
 * ?action=nameActive&name=X (no key) — true if that name (or any of
 * its linked aliases) has a fresh heartbeat in "Presence" right now.
 *
 * ─────────────────────────────────────────────────────────────
 * PDF ACCESS TOKENS
 * ─────────────────────────────────────────────────────────────
 * ?action=getPdfToken&name=X&sessionId=Y (no admin key). Re-hashes
 * the name and checks it against the REAL, live AccessList/
 * SuspendedNames/Expiry sheets. If that passes, mints a short-lived
 * (20 min) HMAC-signed token that script.js hands to the Cloudflare
 * Worker, which is the only thing that can actually fetch a PDF's
 * bytes from the private Backblaze bucket. TOKEN_SECRET below MUST
 * match the TOKEN_SECRET set as a Secret in that Worker exactly.
 *
 * The token payload is JSON ({sid, name, exp}) rather than a plain
 * "sessionId.expiresAtMs" string — this is what lets the Worker also
 * know WHO a request belongs to, so it can rate-limit and log a
 * direct hit against itself (bypassing script.js entirely) instead
 * of that being invisible to every flag/stat in this file. See
 * mintPdfToken below.
 *
 * SETUP: paste into Extensions → Apps Script, set NOTIFY_EMAIL,
 * ADMIN_KEY, and TOKEN_SECRET below, Deploy → New deployment → Web
 * app → Execute as: Me → Who has access: Anyone. Copy the /exec URL
 * into config.js's logging.endpoint.
 *
 * TO UPDATE LATER: editing this file alone does nothing live — you
 * must Deploy → Manage deployments → Edit → New version → Deploy.
 */

var NOTIFY_EMAIL = "merchantadnan053@gmail.com";


// `recipient` defaults to NOTIFY_EMAIL (your own inbox) — every
// existing call site (feedback, daily digest, login alerts) still
// behaves exactly as before with no changes needed there. The new
// approval-notification emails below are the only callers that pass
// a real `recipient` (the requester's own address) instead of relying
// on the default.
function sendEmail(subject, body, recipient) {
  var to = recipient || NOTIFY_EMAIL;
  // Sends from the Gmail account that owns this script (no third-party
  // email service needed). Returns what happened so the admin page can
  // show it: { ok, via, error }.
  try {
    if (MailApp.getRemainingDailyQuota() > 0) {
      MailApp.sendEmail(to, subject, body, { name: "Class 12 Portal" });
      return { ok: true, via: "gmail", error: "" };
    }
    return { ok: false, via: "", error: "Gmail daily email quota used up (try again tomorrow)" };
  } catch (err) {
    logAdminAction("emailFailed", String(err));
    return { ok: false, via: "", error: "Gmail: " + String(err) };
  }
}

// The admin page proves it knows the admin passphrase: it sends the
// passphrase (over HTTPS, as a POST) and this script hashes it and compares
// the result with ADMIN_KEY below. ADMIN_KEY is the same public hash that is in
// config.js (admin.secretHash), and ADMIN_SALT is config.js's admin.salt. The
// hash alone is NOT enough to get in any more - you have to know the passphrase.
// There is nothing to copy or paste: keep these two matching config.js.
var ADMIN_KEY = "66575fc2e3bd47844b7bb501539c9aa1293b85640c9cf094c2c70840b9c21630";
var ADMIN_SALT = "c12-admin-r4k9";

var _viaPost = false;

function adminKeyMode() { return "secure"; }

function isAdminAuth(params) {
  params = params || {};
  if (!_viaPost) return false;                 // never over a plain web address
  var phrase = String(params.phrase || "").trim();
  if (!phrase) return false;
  return sha256HexGS(ADMIN_SALT + phrase) === ADMIN_KEY;
}

var PORTAL_SALT = "c12-portal-x7q";

var STATIC_ACCESS_HASHES = [
  "cd44a6dc76e850943a98a0fd9c23731f76833c1bbecc876ab3daf259fd2be822", "12494164d568916a50384c29eb9f683e8d1bea34bec9f15f8fed13a0761d4f03", "f5188c339af6c95ab31ee8fd91965892ce3557f0f60f49136b94c57b5e18e61a", "61f81385444c4c205c553379381c122ece3a231b77f91a61cc737f0691809fcc",
  "207a83cc143c5c6b9f502326f6fc120683b8e3cd68e7ee70aa14e02b77308c87", "1704f1b6b18b2008352e7badd7dbd41d31244f4ccb449536069a94349e14da2e", "c11d7095e18d9a9557406480b6905d3f34f9842fcf9b99ac5317fca278a3a67e", "cd6a762b1b472e6d1e0de3b4b86a317fc4ba4fa4fa6dd12c4de4b15205f7387d",
  "a938328c760161fe3d06e925212a521002bbdf36c3b47d9c9860c05b1f167711", "8e758be8cd40e94be10dc10838944b7f74e9cfb4742035a8cb506a5367e27446", "835f08208571bc0e23a72f24909b7a84520f85a3ddfbe59c1480414367bdc671", "2db2c3a9cc64703d558cd981ebfe55b5c2ff7ac43280d9e8dc857ac18deb51f0",
  "f8f2a75488a96853f217bfe38b4f267dd87d34efc318d09dc15e3f0bdd6c9816", "39115d8d350ccd34b989968bdda40aa57fc21190a4e1bd4d740a812d840b7313", "f073cdf98b9e0c8befdb512caf472d84787f21dad2af3312d1b247aed5317ffd", "2a2705931d55237b68a9094c3cb1b7be42dc15b512dc7343fd8dfae9c339d48e",
  "154839339a84c5f77dd60137050889366160324188f5d67ac894b85ea15c186b", "3b1e0f2e1267ffcbb5b9add1eef156d25a131e925d9d5bc60d100d712be3cf38", "dcab496ac13a6461ebe5db3af814160f40f0bfe834ccf92cf05672405d834b1d", "1071cbb09808bb1fd7cfe64b013f342bccca655a03292bef1eae470fab3b0a04",
  "12cc1d85df8f176c723d06a0ec39439f357bf6b27d5ee5d8c2e0239c0b96f50b", "bf56b85f4777e1fb2e50955cb60b12937292c456d9e99e4f0f5c186ac84d4a1e", "bf6b562e62276d39da954906beab641c7c5b3af88481761eb768ce3e0fea3749", "32890d1d09c18dd6dde998802ee7e62fa1fc0d2e91f67929a1e4fd77e6bc02ca",
  "5bdd67c9192a61e8cafe6415dd13b45e763e0cf53e7838a74132c5b1c0270beb", "bae581f35fc21fac5da1fb13ce3b64068e67d9dbdf59f16108baeabfc86c43f8", "abbed6a5e6e9be07aad71bcfdd91e83a1485442316d0b921de66ba140f299e11", "f12e6b9e319b570778431c35bfd6c8a2b3aaa42bfce887f8fd55daa458a86c88",
  "b224bcf7e778a7e86a1f979446b65f35abf675d9db21402c2a82ad92f8b70917", "704bc4b38e7e5ff39ec70886d486e644fa4967de3bad33e717473a6c62eae69b", "1e56c81ddeb76b6afb62209d3d26d9b94e01dd5eeb6ea546ad829b0b5b6d1c4f", "cb2bbf08cfa7d9180154f23aeabb645c9ce760d40d4bc0f138bda07a1034d181",
  "3115f6ef1d1471d337e303d65950ed803316717ae11681bcfcdc7ee9b1c85e60", "9b14c02c300fbc1e2afb73b61bbe0e6f0d72d40ad0a245333d72332876b5fde2", "406a4d0ef2d07865d5cd0036f5867674946f526e65ef93b45f84cd6ffc0d0cc0", "9edaf8fca6d0c3b4a8c972de3280e46afaa325708bc38489bd7b7a87f644adcf",
  "78a39f4d64a4bc5572bf63f41fe2a0bf1543c831590b7540dd16dd7c08bc484a", "b365d1f090ee59778c19b3e335b264c1c975a5881159f364d6022bce0f2e0cf3", "64e729e99f794b6b6cf1c4fe30337d22de1a6efbfb22598056dd513d4adb5f00", "bf3569da11c50d45882ca8cd7ee64c39dca2904b1191fcd4c3f2dc402e1f452e",
  "e2d03fd7c6a504a2042c6477ef381edd8bb2adb47bee23bc10c21e042fc4c0b9", "165423c9073efda188ff0f1b784a3e0ed2bef488b7b1ce3cd9bf1ca207d88908", "a7a2ef8f087d616ed046f33615b971085cdbe5acf7ab27708b633225444e1c90", "9ccc35c1bb86c71159d938766c41e46f000fdec2af340e57b1310db2655cd37e",
  "1e37e284b7cd594030107be281415f4f0f128ed7c184e9f1a3962a169669c901", "89460822bf5cc18b055f7ad47b695fd725bea29bb445bfd7962329417979a9c7", "8c464b585651b2a8fc684470a944c950601972050d16ca5d44002254c7a477e5", "2598d55416beb174ebaea17e86781b0adecdb612cc3f8fec3f7784c32839798e",
  "d0038235e66f659eccf1388a2dfe84261bd6342533a79be6adb024675bc84a7d", "d616e5c3f55a46e59224d54af0f537a7bc34e8c905b541b728709a96354f304b", "79c66be7cb3e4dcdd5702b8d1419b011dd348cb65cbf8ae0ae149abf9420979f", "f0f4ad8d1eb4e039c016f758c3c0e86b1ca4a3aefeb965aa5ec3036b86aaabd6",
  "3760a081914edc8c952020d10e31031e16250702a93be6e22b704fb53b28b992", "221e84c47682a8618eb3231089c943646c9fd8ed6c0650ae5e8605b55ed7fc9d", "1e2028eb27ad9ed7b5955a5d1053e30cbc578fbc58a8c7d5ce7db9517b9893bc", "dda076a572aaeed67c53803f7091f3b000a74714d06325b54c5178df6224b30b",
  "8c1532b57c1d8457fea78508eb7f06610e00c6edbf73e625dabe7aca586552db", "23a0e63fb721d35a71f57cf127702bc5442f36bb964d3bfce0f41caf6f3a3160", "d23de7dcea6da443e03d706b4de212fa305f1f38b6c7e58891222dc9b6287a29", "9d888db82a9b9f35cafe0589dd24fffb5349b9c8ce73f67e200fafc3130d6c54",
  "b43072ccb1e773314a9b4a1e27119d86c879f73205942d840208f7684e146bc4", "625c200b9744aec28f51e6f1e3be87129132a96252fe57c82878f1f74fb60966", "99744bc3201d9661fa950c38e1c5735d9b66a3a7339bcd108a7911897936037b", "e7c54a5b7df47e98e092e221b146d640db733ae0c70c8f3f540ec066009d9229",
  "1317e72235fceb27f1af03a99e83b527611c475fc05ca2e4995dd80890665ac1", "fc24f737adbbf2fc6c762bcf2d88e0b16eb257e79c0d55ea67d573a1fb6bd6bc", "a18793e45601fe6f2f06ba550af9f1c4d3da79529635898eb1cac79a68529332", "2590f9b391f4678ba784597ab3060976c1d1c4c22abc18ed3b97e34e7bdeff3a",
  "f9d82843a9ac2cf194f9dd3d6695e37a85128e004650e034e59fe06653932ff1", "9c3f9266f5b0c5c669a5830896b933b4d7c65be6d4e56d3954328bde6a7f5205", "9154015ce26688e4af9e5bce68874814ed737e793e593864cd43520519d1221f", "2e940ac31814a52b7572e305286b23fc6fbfb7c33e2fb2f048b20f61afa0e443",
  "6e2193964afe1e920c9faca520d39aa54c6496e0cce1c9c026c74d3275c326be", "6fe8324297ac2677b2278d82e26c9447be25bc7ab994da8ca21cbbc2ea4b1c65", "9d54ac46cee9293029e288f2d63845bb8b076ece07f522b5728ecb64c12d2eb9", "fbf4ad7925e78a59aa9951f10f33b3897590f2ba3fbf6749fe5f304862bac531",
  "9b8e0b55644716d8146b1be4d88753c9f33588ad648c928b6513bf78db6db87a", "55b9e7b999051816022810037c4c5323525618a2be9bae66aa327bc071be05a1", "8f0976a68faf8189f05e0db2846395b44c7d79854b9b65b22124905fc6ac82f1", "3438f8f043a52ef3efb39a193a1a97ae6af34c431c9bd61fed83bba4df4664de",
  "1dcb85a0e74383e3fa6923695320bf24def3f67ccce1b3a41d4ab37be193aeb7", "3c97d18dce51f9d91b77f54977f7bdb256eba0f99e370591fe0f6cb58b763fbd", "b23f497bc4bbbefa2afe8cbb97aaa20bc7948796aadfbdff6c7ecc4164346e24", "aff91156b87652bd5760c7ab00625f853ca59fe7908b78e779d88fe187d5e7ce",
  "5359c4bde93b76ab69dabe8de3aa21344aba51ad27d5a539780c6d004a79c4f0", "18b816cac92b3568ae64c470c1a67c35693de03f774cdb510aa1c52fcba84a1e", "38cea51366535dca638f2d4fc1e76d629c0dce11218e69481c9cd5f8b3dbe52d", "5f862ead45b9041334010a2afbb8a9dec35094bba8ac3d8e197a765cad95a0a5",
  "863f02c05eb54e4ff3cd7c4b858509ee7d05242a91e6955678d9682b992a0a20", "21d4fbf7fdd644d82309ee7bb00a2dfc07fe471e7dbb6fe0c14d11fbeca8b47e", "6bab2a999ee9823eb7f88809ab50a782f4ff7a955d87cc58f7be3008f5d225bd", "61e6d917fc74b0eb91d78ca6e31058ef6f44f47069528bae7047b41962c3ee2a",
  "79bf0afab245f1a36ed242942fd0f20bb45549608de2afe8529c621ab3ec92a6", "e26000e30bdeaf6121dd61b2ab7fca7c3904eb5eda410c01bacbbc9b47c309e4", "ea28c05974a62da5fad0f3b840a9eea357a1b49b3c7d5e69d7a67d997cdb6363", "4c3bb86e7a0ea509b3d14f0bb9690c8b8aec01656893c1373ddaeb415cdaa78d",
  "a53a1d080ff2351a12a57d514dfa2f54e95d239d7edb929cdca3c78a20f30f2b", "a8147833384eb93df97499a131eba8be7f1ab75f373a59db2667ff61e1a92762", "84bf9a3d0a3203d2bd2ba74b6314516d353f5f0b4288ab905a532d81af12b943", "d10c9d275829406b52b5a625122883ae6298cf9ed73d19b0f4f9261b6bd62fb5",
  "18c157bb3b1ceb49f6a7a44fe5592bfbf38cbaa7a4685774144aeeea7092d5fb", "a0baf5519ca32d4571a263634b437c5d01f6d9dae6dede3ea81a55774e72a1b1", "7f3c302376ff1b99f333c816af32a713928c68d002602481b3bea01c89852e16"
];

var TOKEN_SECRET = "Tq4CnZz9hyNJzU8sN1Fp8iMaqCjQsKNxW518zTez";

// Must be the EXACT same URL as SITE_CONFIG.pdfWorker.url in
// config.js. Used only by revokePdfTokensForSession below, to tell
// the Worker "kill any in-flight token for this session right now" —
// closes the gap where suspending someone still left their
// already-issued PDF token working for up to 20 more minutes, since
// the Worker previously only checked a token's signature and expiry,
// never whether it had been suspended since being issued.
var PDF_WORKER_URL = "https://class12-pdf-gate.merchantadnan052.workers.dev";

// Must be the EXACT same salt as SITE_CONFIG.protectedAccounts.salt
// in config.js. Formula: sha256hex(CRED_SALT + normalizedUsername +
// "|" + password) — same shape as the access-list hashing elsewhere
// in this file, just with its own separate salt so credential hashes
// and plain name hashes can never collide with each other.
var CRED_SALT = "c12-cred-9xQwZaK4";

// Seed list for the three protected accounts (name+password logins)
// — same pattern as STATIC_ACCESS_HASHES above: a hardcoded starting
// set, extendable later via a ProtectedAccounts sheet (Username |
// PasswordHash) without needing a redeploy. Neither this file nor
// config.js ever stores an actual password — only these one-way
// hashes, computed once and pasted in here.
var STATIC_PROTECTED_ACCOUNTS = {
  "adnan": "f608dbf245cffcf279c4580357963e461b8c19109ce310aab092b9b064ad0c72",
  "kaushal": "b1b1314e32579b734a06bba2419c2976b3c9f2aa28777b82883be33d413f8f70",
  "kaushal bhardwaj": "d388bb5c106ec2e454a3f99d3b7da0ebe77278278df0281f0c6c2bab75fa9b3b",
  "khushbu": "d5ed6295a9fc29ef1e90a8db4d218c2ac5b68866d41489335245d9c141f0e524",
  "khushbu bhavsar": "da2e9f039c27661161c5319b50bbad9c4e5ce835f062f6b44bc8f14e781fd668"
};

var PRESENCE_STALE_MS = 90 * 1000;

// ── Read cache ───────────────────────────────────────────────────
// Every login, password check and PDF-token request used to re-read
// several whole sheets (access list, suspended list, expiry, blocked
// devices, protected accounts) from scratch, on every single call.
// Sheet reads are the slow part of an Apps Script execution, and
// Apps Script only runs ~30 requests at once before new ones queue or
// fail — so as more people used the site, everything (login, PDF
// tokens, thumbnails) slowed down together. These lists change rarely,
// so they're now kept in CacheService for a short time. Anything that
// changes one of them calls invalidateCaches() straight away, so an
// approval, suspension or expiry still takes effect immediately.
// Presence (the one-device-at-a-time check) is deliberately NOT cached.
var CACHE_TTL_SECONDS = 60;
var CACHE_KEYS = ["c_pins", "c_access", "c_susp", "c_expired", "c_blocked", "c_protected", "c_alias"];

function cachedRead(key, loader) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { return loader(); }
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* fall through to a fresh read */ }
  var value = loader();
  try { cache.put(key, JSON.stringify(value), CACHE_TTL_SECONDS); } catch (e) { /* too big or unavailable — still return the fresh value */ }
  return value;
}

function cachedSessionRead(key, loader) {
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(key);
    if (hit !== null && hit !== undefined) return JSON.parse(hit);
    var value = loader();
    try { cache.put(key, JSON.stringify(value), 60); } catch (e) {}
    return value;
  } catch (e) { return loader(); }
}

function invalidateCaches() {
  try { CacheService.getScriptCache().removeAll(CACHE_KEYS); } catch (e) { /* nothing cached is fine */ }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data.type === "heartbeat") {
      upsertPresence(data);
      // Readable reply (the site now asks for it): any waiting admin
      // command + "studied today", so the browser needs ONE request
      // per minute instead of three.
      var hbSid = data.sessionId || "";
      var hbCmd = { message: "", forceLogout: false }, hbToday = 0;
      try { hbCmd = readAndClearCommand(hbSid); } catch (e1) {}
      try { hbToday = cachedSessionRead("today_" + hbSid, function () { return getTodayStatsForSession(hbSid).todaySeconds; }); } catch (e2) {}
      return jsonOut({ ok: true, cmd: hbCmd, todaySeconds: hbToday });
    }

    if (data.type === "feedback") {
      submitFeedback(data);
      return jsonOut({ ok: true });
    }

    if (data.type === "progress") {
      return jsonOut(handleProgress(data));
    }

    if (data.type === "pin") {
      return jsonOut(handlePin(data));
    }

    if (data.type === "pinReset") {
      return jsonOut(handlePinReset(data));
    }

    if (data.type === "fileRequest") {
      submitFileRequest(data);
      return jsonOut({ ok: true });
    }

    // Admin calls now arrive here (POST) so the key never appears in a URL.
    if (data.type === "admin") {
      var ap = data.params || {};
      ap.action = data.action;
      ap.phrase = data.phrase;
      _viaPost = true;
      return doGet({ parameter: ap });
    }

    if (data.type === "confirmCatalogAdditions") {
      _viaPost = true;
      if (!isAdminAuth({ phrase: data.phrase })) return jsonOut({ ok: false, error: "unauthorized" });
      var addedCount = confirmCatalogAdditions(data.items || []);
      logAdminAction("confirmCatalogAdditions", addedCount + " file(s) added to catalog");
      return jsonOut({ ok: true, added: addedCount });
    }

    // Only the important things are written to the Log (see shouldRecordEvent).
    if (!shouldRecordEvent(data)) return jsonOut({ ok: true, skipped: true });

    var sheet = ensureLogSheet();

    sheet.appendRow([
      new Date(),
      data.type || "",
      sanitizeForSheet(data.name || ""),
      data.detail || "",
      data.page || "",
      data.sessionId || "",
      data.viewId || "",
      (data.duration === undefined || data.duration === null || data.duration === "") ? "" : data.duration
    ]);

    if (data.type === "login" && data.detail === "approval_requested") {
      recordApprovalRequest(data);
    }

    if (data.type === "login" && (data.detail === "suspended" || data.detail === "abusive")) {
      var deviceId = extractField(data.page, "device");
      if (deviceId) addBlockedDevice(deviceId, extractField(data.page, "label"));
    }

    if (data.type === "session_end" && data.sessionId) {
      removePresence(data.sessionId);
    }

    sendNotification(data);

    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action;

    // Does nothing on purpose: the site calls this as soon as the login
    // page opens so the script is already warm (Apps Script's cold start
    // is a few seconds) by the time someone finishes typing.
    if (action === "ping") return jsonOut({ ok: true });

    // Open  <your web app address>?action=version  in a browser tab to see
    // which version of this script is really live.
    if (action === "version") return jsonOut({ ok: true, build: "2026-10-10-l", adminKeyMode: adminKeyMode() });

    if (action === "blockedDevices") {
      return jsonOut({ ok: true, blockedDevices: getBlockedDeviceIds() });
    }

    if (action === "accessList") {
      return jsonOut({ ok: true, accessHashes: getAccessHashesArr() });
    }

    if (action === "suspendedNames") {
      return jsonOut({ ok: true, suspendedHashes: getSuspendedHashesArr().concat(getExpiredHashes()) });
    }

    if (action === "nameActive") {
      return jsonOut({ ok: true, active: isNameActive(e.parameter.name || "") });
    }

    // Both of these scan the ENTIRE Log sheet, which keeps growing — so
    // as the log gets bigger they get slower, and while one runs it
    // occupies one of the ~30 execution slots everything else (login,
    // PDF tokens) needs. A minute of caching per session costs nothing
    // (these are progress/time-spent figures, not access decisions).
    if (action === "todayStats") {
      var tsSid = e.parameter.sessionId || "";
      var tsVal = cachedSessionRead("today_" + tsSid, function () { return getTodayStatsForSession(tsSid).todaySeconds; });
      return jsonOut({ ok: true, todaySeconds: tsVal });
    }

    if (action === "myProgress") {
      var mpSid = e.parameter.sessionId || "";
      var mpVal = cachedSessionRead("progress_" + mpSid, function () { return getMyProgressForSession(mpSid); });
      return jsonOut(Object.assign({ ok: true }, mpVal));
    }

    if (action === "loginCheck") {
      return jsonOut({
        ok: true,
        blockedDeviceIds: getBlockedDeviceIds(),
        accessHashes: getAccessHashesArr(),
        suspendedHashes: getSuspendedHashesArr().concat(getExpiredHashes()),
        active: isNameActive(e.parameter.name || "")
      });
    }

    if (action === "stats") {
      var st = cachedStat("stat_public", 300, function () {
        var seenP = {}, nf = 0;
        getCatalogRows().forEach(function (r) { if (!seenP[r.filePath]) { seenP[r.filePath] = 1; nf++; } });
        return { studiedToday: getStudiedTodayCount(), files: nf };
      });
      return jsonOut({ ok: true, studiedToday: st.studiedToday, files: st.files });
    }

    if (action === "checkCredentials") {
      var valid = checkCredentials(e.parameter.username || "", e.parameter.credHash || "");
      return jsonOut({ ok: true, valid: valid });
    }

    if (action === "catalog") {
      return jsonOut({ ok: true, catalog: getPublicCatalog(), announcement: getAnnouncement() });
    }

    if (action === "getPdfToken") {
      var pName = e.parameter.name || "";
      var pSessionId = e.parameter.sessionId || "";
      if (!pName || !pSessionId) {
        return jsonOut({ ok: false, error: "missing_params" });
      }

      var pNorm = normalizeNameGS(pName);
      var pHash = sha256HexGS(PORTAL_SALT + pNorm);

      var pAccessHashes = getAccessHashesArr();
      var pSuspendedHashes = getSuspendedHashesArr().concat(getExpiredHashes());

      if (pAccessHashes.indexOf(pHash) === -1) {
        return jsonOut({ ok: false, error: "not_on_access_list" });
      }
      if (pSuspendedHashes.indexOf(pHash) !== -1) {
        return jsonOut({ ok: false, error: "suspended" });
      }

      // Students who chose a PIN must prove it (or be on a trusted device).
      // Everyone (except the password-protected admin accounts) must have a password and prove it.
      var pNeeds = !getProtectedAccountsMap()[pNorm];
      if (pNeeds && (!pinKeysSet()[pHash] || !verifyPinTrust(pName, e.parameter.pt || ""))) {
        return jsonOut({ ok: false, error: "pin_required" });
      }

      return jsonOut({ ok: true, token: mintPdfToken(pSessionId, pName) });
    }

    if (action === "checkCommands") {
      var sid = e && e.parameter && e.parameter.sessionId;
      return jsonOut(Object.assign({ ok: true }, readAndClearCommand(sid)));
    }

    // One-active-device-per-person: called once, fire-and-forget, right
    // after a successful login (see script.js's showApp). Reuses the
    // exact same Commands/forceLogout delivery this file already had
    // for the admin's manual "force logout" button — this just
    // triggers it automatically instead of a human clicking it. If
    // this name already had a different session marked active, that
    // OLDER session gets force-logged-out; the device logging in now
    // becomes the new active one. Costs one small sheet lookup on
    // login only — nothing added to page browsing or PDF viewing, so
    // it can't slow either of those down.
    if (action === "claimSession") {
      var csName = e.parameter.name || "";
      var csSessionId = e.parameter.sessionId || "";
      if (csName && csSessionId) claimActiveSession(csName, csSessionId);
      return jsonOut({ ok: true });
    }

    var adminActions = [
      "adminSummary", "personDetail", "presenceLive", "sendMessage", "forceLogout",
      "unauthorizedQueue", "approveName", "rejectName", "unrejectName", "rejectedQueue", "mergeIdentities", "suspendIdentity", "unsuspendIdentity",
      "setExpiry", "adminActionLog", "flags", "contentStats", "adminDashboard", "archiveOldLogs",
      "blockedDevicesFull", "unblockDevice", "archivePreview", "confirmCatalogAdditions", "tidySheet", "feedbackList", "scanBackblaze", "syncCatalog", "testEmail",
      "setAnnouncement", "clearAnnouncement", "resolveRequest", "resetPin", "digestStatus", "setWeeklyDigest", "sendWeeklyNow", "getPassword", "setPassword", "backupStatus", "setBackup", "sendBackupNow"
    ];
    if (adminActions.indexOf(action) !== -1) {
      if (!isAdminAuth(e && e.parameter)) {
        // keyFp is a one-way fingerprint (safe to show) so the admin page can say
        // whether the deployed key matches the one it is sending.
        return jsonOut({ ok: false, error: "unauthorized", keyMode: "secure" });
      }
      if (action === "adminSummary") return jsonOut({ ok: true, people: getAdminSummary() });
      if (action === "personDetail") {
        var pd = getPersonDetail(e.parameter.name || "");
        return jsonOut({ ok: true, name: e.parameter.name || "", events: pd.events, totals: pd.totals });
      }
      if (action === "presenceLive") return jsonOut({ ok: true, online: getPresenceLive() });
      if (action === "sendMessage") {
        upsertCommand(e.parameter.sessionId || "", { message: e.parameter.message || "" });
        logAdminAction("sendMessage", "to session " + (e.parameter.sessionId || "") + ": " + (e.parameter.message || ""));
        return jsonOut({ ok: true });
      }
      if (action === "forceLogout") {
        upsertCommand(e.parameter.sessionId || "", { forceLogout: true });
        logAdminAction("forceLogout", "session " + (e.parameter.sessionId || ""));
        return jsonOut({ ok: true });
      }
      if (action === "unauthorizedQueue") {
        return jsonOut({ ok: true, queue: getUnauthorizedQueue() });
      }
      if (action === "approveName") {
        var apRes = approveName(e.parameter.name || "");
        if (apRes.ok) logAdminAction("approveName", e.parameter.name || "");
        return jsonOut({ ok: !!apRes.ok, error: apRes.error || "", result: apRes });
      }
      if (action === "rejectName") {
        var rjRes = rejectName(e.parameter.name || "");
        if (rjRes.ok) logAdminAction("rejectName", e.parameter.name || "");
        return jsonOut({ ok: !!rjRes.ok, error: rjRes.error || "", result: rjRes });
      }
      if (action === "testEmail") {
        var teTo = e.parameter.to || NOTIFY_EMAIL;
        if (!isValidEmailGS(teTo)) return jsonOut({ ok: false, error: "That isn't a valid email address" });
        var teRes = sendEmail("Test email — Class 12 Portal", "If you can read this, email sending from the Class 12 Portal works.", teTo);
        logAdminAction("testEmail", teTo + (teRes.ok ? " sent via " + teRes.via : " FAILED: " + teRes.error));
        return jsonOut({ ok: true, to: teTo, result: teRes });
      }
      if (action === "unrejectName") {
        unrejectName(e.parameter.name || "");
        logAdminAction("unrejectName", e.parameter.name || "");
        return jsonOut({ ok: true });
      }
      if (action === "rejectedQueue") {
        return jsonOut({ ok: true, queue: getRejectedQueue() });
      }
      if (action === "mergeIdentities") {
        mergeIdentities(e.parameter.primary || "", e.parameter.alias || "");
        logAdminAction("mergeIdentities", (e.parameter.alias || "") + " -> " + (e.parameter.primary || ""));
        return jsonOut({ ok: true });
      }
      if (action === "suspendIdentity") {
        var s = suspendIdentity(e.parameter.name || "");
        logAdminAction("suspendIdentity", e.parameter.name || "");
        return jsonOut({ ok: true, result: s });
      }
      if (action === "unsuspendIdentity") {
        var u = unsuspendIdentity(e.parameter.name || "");
        logAdminAction("unsuspendIdentity", e.parameter.name || "");
        return jsonOut({ ok: true, result: u });
      }
      if (action === "resetPin") {
        var rpOk = resetPin(e.parameter.name || "");
        logAdminAction("resetPin", e.parameter.name || "");
        return jsonOut({ ok: true, removed: rpOk });
      }
      if (action === "resetRequests") return jsonOut({ ok: true, requests: readResetRequests() });
      if (action === "dismissReset") {
        dismissResetRequest(e.parameter.name || "");
        return jsonOut({ ok: true });
      }
      if (action === "classProgress") return jsonOut(Object.assign({ ok: true }, getClassProgress()));
      if (action === "clientErrors") return jsonOut({ ok: true, errors: getClientErrors() });
      if (action === "getPassword") {
        return jsonOut(Object.assign({ ok: true }, adminGetPassword(e.parameter.name || "")));
      }
      if (action === "setPassword") {
        var spRes = adminSetPassword(e.parameter.name || "", String(e.parameter.password || ""));
        if (spRes.ok) logAdminAction("setPassword", e.parameter.name || ""); // the password itself is never written to the log
        return jsonOut(spRes);
      }
      if (action === "backupStatus") return jsonOut({ ok: true, on: backupOn() });
      if (action === "setBackup") {
        var bkOn = String(e.parameter.on) === "1";
        setBackup(bkOn);
        logAdminAction("setBackup", bkOn ? "turned on" : "turned off");
        return jsonOut({ ok: true, on: bkOn });
      }
      if (action === "sendBackupNow") {
        var bkRes = sendBackupEmail();
        if (bkRes.ok) logAdminAction("sendBackupNow", bkRes.sheets + " sheets emailed");
        return jsonOut({ ok: !!bkRes.ok, error: bkRes.error || "" });
      }
      if (action === "digestStatus") {
        return jsonOut({ ok: true, on: weeklyDigestOn() });
      }
      if (action === "setWeeklyDigest") {
        var wdOn = String(e.parameter.on) === "1";
        setWeeklyDigest(wdOn);
        logAdminAction("setWeeklyDigest", wdOn ? "turned on" : "turned off");
        return jsonOut({ ok: true, on: wdOn });
      }
      if (action === "sendWeeklyNow") {
        var wdRes = sendWeeklyDigest(true);
        return jsonOut({ ok: !!(wdRes && wdRes.ok), error: wdRes && wdRes.error || "" });
      }
      if (action === "setExpiry") {
        setExpiry(e.parameter.name || "", e.parameter.date || "");
        logAdminAction("setExpiry", (e.parameter.name || "") + " -> " + (e.parameter.date || "(cleared)"));
        return jsonOut({ ok: true });
      }
      if (action === "adminActionLog") {
        return jsonOut({ ok: true, log: getAdminActionLog() });
      }
      if (action === "flags") {
        return jsonOut({ ok: true, flags: getFlags() });
      }
      if (action === "contentStats") {
        return jsonOut({ ok: true, stats: getContentStats() });
      }
      if (action === "setAnnouncement") {
        var ann = setAnnouncement(e.parameter.text, e.parameter.kind, Number(e.parameter.days) || 0);
        if (!ann) return jsonOut({ ok: false, error: "Write a message first." });
        logAdminAction("setAnnouncement", String(ann.text).slice(0, 120));
        return jsonOut({ ok: true, announcement: ann });
      }
      if (action === "clearAnnouncement") {
        clearAnnouncement();
        logAdminAction("clearAnnouncement", "banner removed");
        return jsonOut({ ok: true });
      }
      if (action === "resolveRequest") {
        var rr = resolveFileRequest(Number(e.parameter.row));
        if (rr) logAdminAction("resolveRequest", rr);
        return jsonOut({ ok: !!rr, error: rr ? "" : "Request not found" });
      }
      if (action === "adminDashboard") {
        // Each section is built on its own, so one broken section shows
        // its own error instead of taking the whole dashboard down.
        var dErrors = {};
        var safe = function (name, fn, fallback) {
          try { return fn(); } catch (err) { dErrors[name] = String(err && err.message ? err.message : err); return fallback; }
        };
        var dRows = safe("log", function () { return readLogRows(); }, []);
        return jsonOut({
          ok: true,
          people: safe("people", function () { return getAdminSummary(dRows); }, []),
          queue: safe("queue", function () { return getUnauthorizedQueue(dRows); }, []),
          rejectedQueue: safe("rejectedQueue", function () { return getRejectedQueue(); }, []),
          flags: safe("flags", function () { return getFlags(dRows); }, {}),
          stats: safe("stats", function () { return getContentStats(dRows); }, []),
          log: safe("auditLog", function () { return getAdminActionLog(); }, []),
          online: safe("online", function () { return getPresenceLive(); }, []),
          devices: safe("devices", function () { return getBlockedDevicesFull(); }, []),
          feedback: safe("feedback", function () { return getFeedbackList(); }, { entries: [], averageRating: null, count: 0 }),
          overview: safe("overview", function () { return getOverview(dRows); }, { activity: [], filesToday: 0, logRows: 0 }),
          announcement: safe("announcement", function () { return getAnnouncement(true); }, null),
          requests: safe("requests", function () { return getFileRequests(); }, []),
          keyMode: adminKeyMode(),
          adminApi: 2,
          errors: dErrors
        });
      }
      if (action === "confirmCatalogAdditions") {
        var ccItems = e.parameter.items;
        if (!Array.isArray(ccItems)) return jsonOut({ ok: false, error: "no files sent" });
        var ccAdded = confirmCatalogAdditions(ccItems);
        logAdminAction("confirmCatalogAdditions", ccAdded + " file(s) added to catalog");
        return jsonOut({ ok: true, added: ccAdded });
      }
      if (action === "tidySheet") {
        var tidyReport = tidySheet();
        logAdminAction("tidySheet", tidyReport.join("; "));
        return jsonOut({ ok: true, report: tidyReport });
      }
      if (action === "archivePreview") {
        return jsonOut({ ok: true, preview: archivePreview(Number(e.parameter.days) || 60) });
      }
      if (action === "archiveOldLogs") {
        var result = archiveOldLogs(Number(e.parameter.days) || 60);
        logAdminAction("archiveOldLogs", result.archived + " rows older than " + (e.parameter.days || 60) + " days");
        return jsonOut({ ok: true, result: result });
      }
      if (action === "blockedDevicesFull") {
        return jsonOut({ ok: true, devices: getBlockedDevicesFull() });
      }
      if (action === "unblockDevice") {
        var removed = unblockDevice(e.parameter.deviceId || "");
        logAdminAction("unblockDevice", e.parameter.deviceId || "");
        return jsonOut({ ok: true, removed: removed });
      }
      if (action === "feedbackList") {
        return jsonOut(Object.assign({ ok: true }, getFeedbackList()));
      }
      if (action === "scanBackblaze") {
        return jsonOut(scanBackblazeForNewFiles());
      }
      if (action === "syncCatalog") {
        var syncResult = syncCatalog();
        logAdminAction("syncCatalog", syncResult.ok ? syncResult.added + " files synced from Backblaze" : "failed: " + (syncResult.error || ""));
        return jsonOut(syncResult);
      }
    }

    return jsonOut({ ok: true, ready: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  // Marks answers to the new POST admin calls so the admin page can tell
  // an updated script from an old one.
  if (_viaPost && obj && typeof obj === "object") obj.adminApi = 2;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── PDF access token minting ────────────────────────────────────
// Payload is now JSON ({sid, name, exp}) instead of a plain
// "sessionId.expiresAtMs" string. Why: the Cloudflare Worker needs to
// know WHO a request belongs to, not just whether the token is valid
// — that's what lets it rate-limit and log a direct hit against
// itself (someone bypassing script.js and curling the Worker
// straight with a captured token), which used to be completely
// invisible to every flag and stat in this file. This MUST match the
// Worker's verifyToken exactly — if you update one, update both and
// redeploy both.
function mintPdfToken(sessionId, name) {
  var expiresAt = Date.now() + 20 * 60 * 1000; // 20 minutes
  var payload = JSON.stringify({ sid: sessionId, name: name || "", exp: expiresAt });
  var sigBytes = Utilities.computeHmacSha256Signature(payload, TOKEN_SECRET);
  var sig = Utilities.base64EncodeWebSafe(sigBytes).replace(/=+$/, "");
  var payloadB64 = Utilities.base64EncodeWebSafe(payload, Utilities.Charset.UTF_8).replace(/=+$/, "");
  return payloadB64 + "." + sig;
}

function normalizeNameGS(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function sanitizeForSheet(str) {
  var s = String(str || "");
  return /^[=+\-@]/.test(s) ? ("'" + s) : s;
}

function sha256HexGS(str) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return digest.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function dayKeyGS(d) {
  if (!(d instanceof Date)) return "unknown";
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

function ensureLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var headers = ["Timestamp", "Type", "Name", "Detail", "Page", "SessionId", "ViewId", "DurationSeconds"];
  var sheet = ss.getSheetByName("Log");
  if (!sheet) {
    sheet = ss.insertSheet("Log");
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var lastCol = sheet.getLastColumn();
  if (lastCol < headers.length) {
    sheet.getRange(1, lastCol + 1, 1, headers.length - lastCol).setValues([headers.slice(lastCol)]);
  }
  return sheet;
}

function ensureSimpleSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var lastCol = sheet.getLastColumn();
  if (lastCol < headers.length) {
    sheet.getRange(1, lastCol + 1, 1, headers.length - lastCol).setValues([headers.slice(lastCol)]);
  }
  return sheet;
}

function ensureAccessListSheet() { return ensureSimpleSheet("AccessList", ["NameHash", "Name", "AddedAt"]); }
function ensureProtectedAccountsSheet() { return ensureSimpleSheet("ProtectedAccounts", ["Username", "PasswordHash", "AddedAt"]); }

// Combines the hardcoded seed accounts with any added later via the
// ProtectedAccounts sheet — same static-plus-live pattern as
// STATIC_ACCESS_HASHES + AccessList. Sheet entries win on conflict
// (so a password can be changed by editing the sheet without a
// redeploy) via Object.assign's left-to-right overwrite.
function getProtectedAccountsMap() {
  var map = Object.assign({}, STATIC_PROTECTED_ACCOUNTS);
  // Was reading the sheet directly (ss.getSheetByName) instead of
  // going through ensureProtectedAccountsSheet like every other
  // sheet in this file does — which meant the sheet never actually
  // got created, and the "add more accounts later via the sheet
  // without a redeploy" design this comment promises silently
  // didn't work. Same self-creating pattern as AccessList,
  // SuspendedNames, etc. now applies here too.
  var sheetRows = cachedRead("c_protected", function () {
    var sheet = ensureProtectedAccountsSheet();
    if (sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().map(function (r) { return [String(r[0] || ""), String(r[1] || "")]; });
  });
  sheetRows.forEach(function (r) {
    var username = normalizeNameGS(r[0]);
    if (username && r[1]) map[username] = r[1];
  });
  return map;
}

// Verifies a username+password pair without either ever crossing the
// network in plaintext — the caller (script.js) hashes
// CRED_SALT + normalizedUsername + "|" + password client-side first
// and sends only that hash. This function just compares it against
// the stored hash for that username. Unlike the access-list hashes in
// config.js, none of these hashes are ever shipped to the browser —
// they only ever live here, so a guess has to actually hit this
// endpoint to be checked; it can't be brute-forced offline just by
// reading the public site files.
function checkCredentials(username, credHash) {
  if (!username || !credHash) return false;
  var norm = normalizeNameGS(username);
  var map = getProtectedAccountsMap();
  return !!map[norm] && map[norm] === credHash;
}

function ensureRejectedSheet() { return ensureSimpleSheet("RejectedNames", ["NormalizedName", "Name", "RejectedAt"]); }
function ensureSuspendedSheet() { return ensureSimpleSheet("SuspendedNames", ["NameHash", "Name", "SuspendedAt"]); }
function ensureIdentitiesSheet() { return ensureSimpleSheet("Identities", ["IdentityId", "CanonicalName", "Status", "CreatedAt"]); }
function ensureAliasesSheet() { return ensureSimpleSheet("Aliases", ["NormalizedAlias", "IdentityId"]); }

function initializeAllSheets() {
  ensureLogSheet();
  ensureAccessListSheet();
  ensureProtectedAccountsSheet();
  ensureRejectedSheet();
  ensureSuspendedSheet();
  ensureIdentitiesSheet();
  ensureAliasesSheet();
  ensureExpirySheet();
  ensureAdminActionsSheet();
  ensureFeedbackSheet();
  ensureCatalogSheet();
  ensureSimpleSheet("Presence", ["SessionId", "Name", "LastSeen", "CurrentPage", "SessionStart"]);
  ensureSimpleSheet("BlockedDevices", ["DeviceId", "FirstBlockedAt", "DeviceLabel"]);
  ensureSimpleSheet("Commands", ["SessionId", "Message", "ForceLogout", "UpdatedAt"]);
}

function readFirstColumn(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getValues()
    .map(function (r) { return String(r[0] || "").trim(); })
    .filter(String);
}

function getAccessHashesArr() { return STATIC_ACCESS_HASHES.concat(cachedRead("c_access", function () { return readFirstColumn("AccessList"); })); }
function getSuspendedHashesArr() { return cachedRead("c_susp", function () { return readFirstColumn("SuspendedNames"); }); }

function getAliasInfo() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var idSheet = ss.getSheetByName("Identities");
  var aliasSheet = ss.getSheetByName("Aliases");

  var aliasToIdentity = {};
  var identityAliases = {};
  var identityCanonical = {};
  var identityStatus = {};

  if (idSheet && idSheet.getLastRow() > 1) {
    idSheet.getRange(2, 1, idSheet.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var id = r[0];
      if (!id) return;
      identityCanonical[id] = r[1] || "";
      identityStatus[id] = r[2] || "active";
    });
  }
  if (aliasSheet && aliasSheet.getLastRow() > 1) {
    aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var alias = r[0], id = r[1];
      if (!alias || !id) return;
      aliasToIdentity[alias] = id;
      if (!identityAliases[id]) identityAliases[id] = [];
      identityAliases[id].push(alias);
    });
  }
  return {
    aliasToIdentity: aliasToIdentity,
    identityAliases: identityAliases,
    identityCanonical: identityCanonical,
    identityStatus: identityStatus
  };
}

function resolveAliasSet(rawName, aliasInfo) {
  var info = aliasInfo || getAliasInfo();
  var norm = normalizeNameGS(rawName);
  var id = info.aliasToIdentity[norm];
  return id ? info.identityAliases[id] : [norm];
}

function setIdentityStatus(identityId, status) {
  var sheet = ensureIdentitiesSheet();
  if (sheet.getLastRow() < 2) return;
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === identityId) {
      sheet.getRange(i + 2, 3).setValue(status);
      return;
    }
  }
}

function mergeIdentities(primaryRaw, aliasRaw) {
  if (!primaryRaw || !aliasRaw) return;
  var idSheet = ensureIdentitiesSheet();
  var aliasSheet = ensureAliasesSheet();
  var info = getAliasInfo();

  var normPrimary = normalizeNameGS(primaryRaw);
  var normAlias = normalizeNameGS(aliasRaw);
  if (normPrimary === normAlias) return;

  var primaryId = info.aliasToIdentity[normPrimary];
  if (!primaryId) {
    primaryId = Utilities.getUuid();
    idSheet.appendRow([primaryId, sanitizeForSheet(primaryRaw), "active", new Date()]);
    aliasSheet.appendRow([normPrimary, primaryId]);
    info.aliasToIdentity[normPrimary] = primaryId;
    info.identityAliases[primaryId] = [normPrimary];
  }

  var aliasId = info.aliasToIdentity[normAlias];
  if (aliasId && aliasId !== primaryId) {
    var aliasRows = aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < aliasRows.length; i++) {
      if (aliasRows[i][1] === aliasId) {
        aliasSheet.getRange(i + 2, 2).setValue(primaryId);
      }
    }
    var idRows = idSheet.getRange(2, 1, idSheet.getLastRow() - 1, 1).getValues();
    for (var j = 0; j < idRows.length; j++) {
      if (idRows[j][0] === aliasId) { idSheet.deleteRow(j + 2); break; }
    }
  } else if (!aliasId) {
    aliasSheet.appendRow([normAlias, primaryId]);
  }
}

// ── Approval requests ───────────────────────────────────────────────
// Every "Send my name for approval" tap is ALSO written to its own small
// sheet. The admin queue and the approval email read this tiny sheet
// instead of scanning the huge Log (which was slow and made the whole
// admin dashboard fail when the Log grew). Older requests that only
// exist in the Log are still found by reading its most recent rows.
function ensureApprovalRequestsSheet() {
  return ensureSimpleSheet("ApprovalRequests", ["Norm", "Name", "Email", "RequestedAt", "Device"]);
}

function recordApprovalRequest(data) {
  try {
    var raw = String(data.name || "");
    if (!raw.trim()) return;
    ensureApprovalRequestsSheet().appendRow([
      normalizeNameGS(raw),
      sanitizeForSheet(raw),
      extractField(data.page, "email") || "",
      new Date(),
      extractField(data.page, "device") || ""
    ]);
  } catch (err) {
    logAdminAction("approvalRecordFailed", String(err));
  }
}

function readApprovalRequests() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("ApprovalRequests");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  return values.map(function (r) {
    return { norm: String(r[0] || ""), name: String(r[1] || ""), email: String(r[2] || "").trim(), timestamp: r[3], device: r[4] || "" };
  }).filter(function (r) { return r.norm; });
}

// Most recent email this person gave when asking for access ("" if
// they were added directly by the admin, so there never was one).
function getPendingApprovalEmail(norm) {
  var found = "", foundAt = -1;
  readApprovalRequests().forEach(function (r) {
    if (r.norm !== norm || !r.email) return;
    var ts = r.timestamp instanceof Date ? r.timestamp.getTime() : 0;
    if (ts >= foundAt) { found = r.email; foundAt = ts; }
  });
  if (found) return found;
  readLogTail(4000).forEach(function (r) {
    if (r.type !== "login" || r.detail !== "approval_requested" || !r.name) return;
    if (normalizeNameGS(r.name) !== norm) return;
    var ts = r.timestamp instanceof Date ? r.timestamp.getTime() : 0;
    if (ts >= foundAt) {
      var email = extractField(r.page, "email");
      if (email) { found = email; foundAt = ts; }
    }
  });
  return found;
}

// Adds the name to the access list. Returns what happened so the admin
// page can tell you (instead of failing silently).
function approveName(rawName) {
  if (!rawName) return { ok: false, error: "No name given" };
  var norm = normalizeNameGS(rawName);
  var hash = sha256HexGS(PORTAL_SALT + norm);
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(15000); } catch (e) { locked = false; }
  var added = false;
  try {
    var sheet = ensureAccessListSheet();
    // Read the sheet itself (not the 60-second cache) so approving twice
    // quickly can never add a duplicate row.
    if (readFirstColumn("AccessList").indexOf(hash) === -1) {
      sheet.appendRow([hash, sanitizeForSheet(rawName), new Date()]);
      added = true;
    }
    unrejectName(rawName);
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e2) {} }
  }
  invalidateCaches();
  return { ok: true, added: added, email: notifyApprovalOutcome(rawName, true) };
}

// Dismisses a request from the queue without blocking anything.
function rejectName(rawName) {
  if (!rawName) return { ok: false, error: "No name given" };
  var norm = normalizeNameGS(rawName);
  var sheet = ensureRejectedSheet();
  if (readFirstColumn("RejectedNames").indexOf(norm) === -1) {
    sheet.appendRow([norm, sanitizeForSheet(rawName), new Date()]);
  }
  invalidateCaches();
  return { ok: true, email: notifyApprovalOutcome(rawName, false) };
}

// Emails the requester (only if they gave an email). Runs AFTER the
// approve/reject is already saved and never undoes it. Returns a small
// status object that the admin page shows: { sent, to, via, reason }.
function notifyApprovalOutcome(rawName, wasApproved) {
  try {
    var norm = normalizeNameGS(rawName);
    var email = getPendingApprovalEmail(norm);
    if (!email) return { sent: false, to: "", reason: "No email on file (added directly, or requested before emails were collected)" };
    if (!isValidEmailGS(email)) return { sent: false, to: email, reason: "The email they gave isn't valid" };
    var subject = wasApproved
      ? "You're approved — Class 12 Study Portal"
      : "Class 12 Study Portal — request update";
    var body = wasApproved
      ? ("Hi " + rawName + ",\n\nYou've been approved to access the Class 12 Study Portal. " +
         "Head back to the site and log in with the same name you used to request access.\n\n" +
         "https://ad5253.github.io/isc/")
      : ("Hi " + rawName + ",\n\nYour request to access the Class 12 Study Portal wasn't approved this time. " +
         "If you think this is a mistake, reach out on WhatsApp: https://wa.me/917405806352");
    var r = sendEmail(subject, body, email);
    if (!r.ok) logAdminAction("approvalNotifyFailed", rawName + " <" + email + ">: " + r.error);
    return { sent: r.ok, to: email, via: r.via || "", reason: r.error || "" };
  } catch (err) {
    logAdminAction("approvalNotifyFailed", (rawName || "") + ": " + String(err));
    return { sent: false, to: "", reason: String(err) };
  }
}

function getRejectedNamesArr() { return readFirstColumn("RejectedNames"); }

// Full rows (not just the normalized names) for the admin "Rejected"
// panel — lets you see who and when, and undo a misclick.
function getRejectedQueue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("RejectedNames");
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
    .map(function (r) { return { norm: r[0], name: r[1], rejectedAt: r[2] }; })
    .filter(function (r) { return r.norm; })
    .sort(function (a, b) { return new Date(b.rejectedAt) - new Date(a.rejectedAt); });
}

// Undo a reject — removes it from RejectedNames so it can reappear
// in the normal pending queue on their next attempt (this does NOT
// retroactively approve them; they still need Approve after that).
function unrejectName(rawName) {
  if (!rawName) return;
  var norm = normalizeNameGS(rawName);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("RejectedNames");
  if (!sheet || sheet.getLastRow() < 2) return;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] === norm) { sheet.deleteRow(i + 2); return; }
  }
}

function suspendIdentity(rawName) {
  if (!rawName) return { aliases: [], devicesBlocked: [] };
  var aliasNorms = resolveAliasSet(rawName);
  var sheet = ensureSuspendedSheet();
  var existing = getSuspendedHashesArr();

  aliasNorms.forEach(function (a) {
    var h = sha256HexGS(PORTAL_SALT + a);
    if (existing.indexOf(h) === -1) sheet.appendRow([h, sanitizeForSheet(a), new Date()]);
  });

  var rows = readLogRows();
  var deviceIds = {};
  var deviceLabels = {};
  rows.forEach(function (r) {
    if (r.name && aliasNorms.indexOf(normalizeNameGS(r.name)) !== -1) {
      var d = extractField(r.page, "device");
      if (d) {
        deviceIds[d] = true;
        var lbl = extractField(r.page, "label");
        if (lbl) deviceLabels[d] = lbl;
      }
    }
  });
  Object.keys(deviceIds).forEach(function (d) { addBlockedDevice(d, deviceLabels[d]); });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var presence = ss.getSheetByName("Presence");
  if (presence && presence.getLastRow() > 1) {
    presence.getRange(2, 1, presence.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[1] && aliasNorms.indexOf(normalizeNameGS(r[1])) !== -1) {
        upsertCommand(r[0], { forceLogout: true });
        revokePdfTokensForSession(r[0]);
      }
    });
  }

  var info = getAliasInfo();
  var norm = normalizeNameGS(rawName);
  var id = info.aliasToIdentity[norm];
  if (id) setIdentityStatus(id, "suspended");

  invalidateCaches();
  return { aliases: aliasNorms, devicesBlocked: Object.keys(deviceIds) };
}

// Tells the Cloudflare Worker "reject any token for this session,
// right now" — closes the up-to-20-minutes-still-works gap on
// suspend. Fire-and-forget: if the Worker is unreachable or
// PDF_WORKER_URL isn't set, this silently does nothing rather than
// failing the whole suspend action, since the suspend itself (name +
// device block, force-logout) already happened above regardless.
function revokePdfTokensForSession(sessionId) {
  if (!PDF_WORKER_URL || !sessionId) return;
  try {
    UrlFetchApp.fetch(
      PDF_WORKER_URL + "?action=revoke&sid=" + encodeURIComponent(sessionId) + "&secret=" + encodeURIComponent(TOKEN_SECRET),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    // best-effort only
  }
}

function unsuspendIdentity(rawName) {
  if (!rawName) return { aliases: [] };
  var aliasNorms = resolveAliasSet(rawName);
  var hashesToRemove = aliasNorms.map(function (a) { return sha256HexGS(PORTAL_SALT + a); });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("SuspendedNames");
  if (sheet && sheet.getLastRow() > 1) {
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (hashesToRemove.indexOf(rows[i][0]) !== -1) sheet.deleteRow(i + 2);
    }
  }

  var info = getAliasInfo();
  var norm = normalizeNameGS(rawName);
  var id = info.aliasToIdentity[norm];
  if (id) setIdentityStatus(id, "active");

  invalidateCaches();
  return { aliases: aliasNorms };
}

function ensureExpirySheet() { return ensureSimpleSheet("Expiry", ["NormalizedAlias", "ExpiresAt"]); }

function setExpiry(rawName, dateStr) {
  if (!rawName) return;
  var aliasNorms = resolveAliasSet(rawName);
  var sheet = ensureExpirySheet();

  aliasNorms.forEach(function (norm) {
    var lastRow = sheet.getLastRow();
    var rowIndex = -1;
    if (lastRow > 1) {
      var vals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (vals[i][0] === norm) { rowIndex = i + 2; break; }
      }
    }
    if (!dateStr) {
      if (rowIndex !== -1) sheet.deleteRow(rowIndex);
    } else if (rowIndex === -1) {
      sheet.appendRow([norm, new Date(dateStr)]);
    } else {
      sheet.getRange(rowIndex, 2).setValue(new Date(dateStr));
    }
  });
  invalidateCaches();
}

function getExpiryMap() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Expiry");
  var map = {};
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) map[r[0]] = r[1];
    });
  }
  return map;
}

function getExpiredHashes() {
  return cachedRead("c_expired", computeExpiredHashes);
}

function computeExpiredHashes() {
  var map = getExpiryMap();
  var now = Date.now();
  var hashes = [];
  Object.keys(map).forEach(function (norm) {
    var d = map[norm];
    var t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    if (t && t <= now) hashes.push(sha256HexGS(PORTAL_SALT + norm));
  });
  return hashes;
}

function ensureAdminActionsSheet() { return ensureSimpleSheet("AdminActions", ["Timestamp", "Action", "Detail"]); }

function ensureFeedbackSheet() { return ensureSimpleSheet("Feedback", ["Timestamp", "Name", "Email", "Rating", "Improvements", "Suggestion"]); }

// ── Catalog (Backblaze scan & confirm) ──────────────────────────
// The actual subject/folder/file list students see — moved here
// from being hardcoded in config.js, so adding a new PDF stops
// requiring a GitHub edit + redeploy. Subject-level metadata (name,
// icon, color) stays in config.js since that almost never changes;
// only the FILES themselves live here, since those change constantly.
function ensureCatalogSheet() { return ensureSimpleSheet("Catalog", ["SubjectId", "FolderName", "FileName", "FilePath", "AddedAt"]); }

// Maps a B2 top-level folder name to a subject id — the one place
// this mapping lives, so if a fourth subject is ever added later,
// this is the only line that needs a new entry.
var CATALOG_SUBJECT_FOLDER_MAP = {
  "maths": "maths",
  "physics": "physics",
  "chemistry": "chemistry"
};

function getCatalogRows() {
  var sheet = ensureCatalogSheet();
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues()
    .map(function (r) { return { subjectId: r[0], folderName: r[1], fileName: r[2], filePath: r[3], addedAt: r[4] }; })
    .filter(function (r) { return r.filePath; });
}

// Public — the site fetches this at load time and slots it into
// SITE_CONFIG.subjects[i].subfolders in place of what used to be
// hardcoded there. Grouped by subjectId, then by folder name.
function getPublicCatalog() {
  var rows = getCatalogRows();
  var seen = {};
  var bySubject = {};
  // "New" = added in the last 7 days. A day on which more than half of
  // the whole library was added at once is a bulk import / first sync,
  // not real news, so it never counts as New.
  var DAY = 86400000, now = Date.now();
  var perDay = {};
  rows.forEach(function (r) {
    var t = r.addedAt instanceof Date ? r.addedAt.getTime() : 0;
    if (!t) return;
    var k = Math.floor(t / DAY);
    perDay[k] = (perDay[k] || 0) + 1;
  });
  var total = rows.length;
  function isNewRow(r) {
    var t = r.addedAt instanceof Date ? r.addedAt.getTime() : 0;
    if (!t || now - t > 7 * DAY || now - t < -DAY) return false;
    var k = Math.floor(t / DAY);
    return !(total > 10 && perDay[k] > total / 2);
  }
  rows.forEach(function (r) {
    if (seen[r.filePath]) return; // skip duplicates
    seen[r.filePath] = true;
    if (!bySubject[r.subjectId]) bySubject[r.subjectId] = {};
    if (!bySubject[r.subjectId][r.folderName]) bySubject[r.subjectId][r.folderName] = [];
    var entry = { name: r.fileName, path: r.filePath };
    if (isNewRow(r)) entry.n = 1;
    bySubject[r.subjectId][r.folderName].push(entry);
  });
  var result = {};
  Object.keys(bySubject).forEach(function (subjectId) {
    result[subjectId] = Object.keys(bySubject[subjectId]).map(function (folderName) {
      var folderId = subjectId + "-" + folderName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return { id: folderId, name: folderName, files: bySubject[subjectId][folderName] };
    });
  });
  return result;
}

// Splits a B2 path like "Maths/Chapter 3 - Matrices/example.pdf" into
// {subjectId, folderName, fileName, displayName}. Returns null for
// anything that doesn't look like Subject/Folder/File.pdf — those get
// flagged to the admin as unrecognized rather than silently guessed
// at, since a wrong guess here means a file lands in the wrong place
// on the actual site.
function parseB2Path(path) {
  var parts = String(path).split("/").filter(Boolean);
  if (parts.length < 3) return null;
  var subjectFolder = parts[0];
  var folderName = parts[1];
  var fileName = parts[parts.length - 1];
  var subjectId = CATALOG_SUBJECT_FOLDER_MAP[subjectFolder.toLowerCase()];
  if (!subjectId) return null;
  if (!/\.pdf$/i.test(fileName)) return null;
  var displayName = fileName.replace(/\.pdf$/i, "");
  return { subjectId: subjectId, folderName: folderName, fileName: fileName, filePath: path, displayName: displayName };
}

// Calls the Worker's listFiles action, compares against what's
// already in the Catalog sheet, and returns only the delta — files
// that exist in the bucket right now but aren't in the catalog yet.
// Nothing gets added here; this is the "scan" half of "scan and
// confirm" — see confirmCatalogAdditions for the other half.
function scanBackblazeForNewFiles() {
  if (!PDF_WORKER_URL) return { ok: false, error: "PDF_WORKER_URL isn't set" };
  var res;
  try {
    res = UrlFetchApp.fetch(
      PDF_WORKER_URL + "?action=listFiles&secret=" + encodeURIComponent(TOKEN_SECRET),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    return { ok: false, error: "Could not reach the Worker: " + String(err) };
  }
  if (res.getResponseCode() >= 300) {
    return { ok: false, error: "Worker returned " + res.getResponseCode() + ": " + res.getContentText().slice(0, 300) };
  }
  var data = JSON.parse(res.getContentText());
  if (!data.ok) return { ok: false, error: data.error || "Unknown error listing files" };

  var existingPaths = {};
  getCatalogRows().forEach(function (r) { existingPaths[r.filePath] = true; });

  var newFiles = [];
  var unrecognized = [];
  (data.files || []).forEach(function (f) {
    if (existingPaths[f.path]) return; // already known — not part of the delta
    var parsed = parseB2Path(f.path);
    if (parsed) newFiles.push(parsed);
    else unrecognized.push({ path: f.path });
  });

  return { ok: true, newFiles: newFiles, unrecognized: unrecognized, totalInBucket: (data.files || []).length };
}

// The "confirm" half — takes exactly the list the admin reviewed and
// approved (each {subjectId, folderName, fileName, filePath,
// displayName}) and appends them to the Catalog sheet. Re-checks
// against the current sheet state right before inserting (not just
// trusting whatever the scan found a moment earlier) in case the
// catalog changed in between — e.g. two scans confirmed back to back.
function confirmCatalogAdditions(items) {
  if (!items || !items.length) return 0;
  var sheet = ensureCatalogSheet();
  var existingPaths = {};
  getCatalogRows().forEach(function (r) { existingPaths[r.filePath] = true; });

  var added = 0;
  items.forEach(function (item) {
    if (!item || !item.filePath || existingPaths[item.filePath]) return;
    if (!item.subjectId || !item.folderName || !item.fileName) return;
    sheet.appendRow([
      sanitizeForSheet(item.subjectId),
      sanitizeForSheet(item.folderName),
      sanitizeForSheet(item.displayName || item.fileName),
      sanitizeForSheet(item.filePath),
      new Date()
    ]);
    existingPaths[item.filePath] = true;
    added++;
  });
  return added;
}

// Full sync: clears the Catalog sheet and rebuilds it cleanly in one batch
// from whatever is currently in the Backblaze bucket. Replaces everything with
// a clean, de-duplicated copy straight from the bucket.
function syncCatalog() {
  if (!PDF_WORKER_URL) return { ok: false, error: "PDF_WORKER_URL isn't set" };
  var res;
  try {
    res = UrlFetchApp.fetch(
      PDF_WORKER_URL + "?action=listFiles&secret=" + encodeURIComponent(TOKEN_SECRET),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    return { ok: false, error: "Could not reach the Worker: " + String(err) };
  }
  if (res.getResponseCode() >= 300) {
    return { ok: false, error: "Worker returned " + res.getResponseCode() };
  }
  var data = JSON.parse(res.getContentText());
  if (!data.ok) return { ok: false, error: data.error || "Unknown error" };

  var sheet = ensureCatalogSheet();
  var keepDates = {};
  getCatalogRows().forEach(function (r) { if (r.addedAt instanceof Date && !keepDates[r.filePath]) keepDates[r.filePath] = r.addedAt; });
  var lastRow = sheet.getLastRow();
  var maxRows = sheet.getMaxRows();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), 5)).clearContent();
  }

  var rowsToInsert = [];
  var seen = {};
  (data.files || []).forEach(function (f) {
    if (!f || !f.path || seen[f.path]) return;
    var parsed = parseB2Path(f.path);
    if (!parsed) return; // skip .bzEmpty and non-PDFs
    seen[f.path] = true;
    rowsToInsert.push([
      parsed.subjectId,
      parsed.folderName,
      parsed.displayName,
      parsed.filePath,
      keepDates[parsed.filePath] || new Date()
    ]);
  });

  if (rowsToInsert.length > 0) {
    if (maxRows < rowsToInsert.length + 1) {
      sheet.insertRowsAfter(maxRows, rowsToInsert.length + 1 - maxRows);
    }
    sheet.getRange(2, 1, rowsToInsert.length, 5).setValues(rowsToInsert);
  }

  invalidateCaches();
  return { ok: true, synced: rowsToInsert.length, totalInBucket: (data.files || []).length };
}

// Convenient one-click function to run directly inside Apps Script editor:
function cleanAndSyncCatalogNow() {
  var res = syncCatalog();
  Logger.log("Clean and Sync Result: " + JSON.stringify(res));
  return res;
}


// Format-only re-check, server-side — never trust a client-side check
// alone, since it's trivial to bypass by calling this endpoint
// directly. Same rule as script.js's isValidEmail: real-looking
// domain, proper alphabetic TLD, no double dots. Still can't confirm
// the address actually exists without sending a real verification
// email, which this feature doesn't do.
function isValidEmailGS(email) {
  if (!email) return false;
  var trimmed = String(email).trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.indexOf("..") !== -1) return false;
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,24}$/.test(trimmed);
}

function submitFeedback(data) {
  if (!isValidEmailGS(data.email)) return; // silently drop rather than error — the client already gates on this, so a bad email here means a direct/bypassed call, not a real user mistake
  var sheet = ensureFeedbackSheet();
  var improvementsText = Array.isArray(data.improvements) ? data.improvements.join(", ") : (data.improvements || "");
  sheet.appendRow([
    new Date(),
    sanitizeForSheet(data.name || ""),
    sanitizeForSheet(data.email || ""),
    data.rating || "",
    sanitizeForSheet(improvementsText),
    sanitizeForSheet(data.suggestion || "")
  ]);

  // One email per submission, sent through the same Gmail
  // path everything else uses — this is what actually lets you know a
  // review came in without having to remember to check the sheet.
  var stars = data.rating ? Array(Number(data.rating) + 1).join("\u2605") + Array(6 - Number(data.rating)).join("\u2606") : "(no rating given)";
  var lines = [
    (data.name || "Someone") + " just left feedback on the Class 12 Portal.",
    "",
    "Rating: " + stars,
    "Wants improved: " + (improvementsText || "(none selected)"),
    "Suggestion: " + (data.suggestion || "(none written)"),
    "Contact email: " + (data.email || "(not given)")
  ];
  sendEmail("\uD83D\uDCDD New feedback: " + (data.name || "Someone"), lines.join("\n"));
}

// ── Announcement banner ─────────────────────────────────────────
// One message at a time, shown at the top of every student's home
// screen until it expires or you clear it. Kept in Script Properties
// (no sheet needed).
function getAnnouncement(forAdmin) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("ANNOUNCEMENT");
    if (!raw) return null;
    var a = JSON.parse(raw);
    if (!a || !a.text) return null;
    if (a.expires && Date.now() > a.expires) return forAdmin ? { text: a.text, kind: a.kind, id: a.id, at: a.at, expires: a.expires, expired: true } : null;
    return { id: a.id, text: a.text, kind: a.kind, at: a.at, expires: a.expires || 0 };
  } catch (err) { return null; }
}

function setAnnouncement(text, kind, days) {
  text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 280);
  if (!text) return null;
  kind = kind === "important" ? "important" : "info";
  var now = Date.now();
  var a = { id: String(now), text: text, kind: kind, at: now, expires: days > 0 ? now + days * 86400000 : 0 };
  PropertiesService.getScriptProperties().setProperty("ANNOUNCEMENT", JSON.stringify(a));
  return a;
}

function clearAnnouncement() {
  PropertiesService.getScriptProperties().deleteProperty("ANNOUNCEMENT");
}

// ── "Request a file" from students ──────────────────────────────
function ensureRequestsSheet() { return ensureSimpleSheet("FileRequests", ["Time", "Name", "Request", "Status"]); }

function submitFileRequest(data) {
  var text = String(data.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  var name = String(data.name || "").trim().slice(0, 80);
  if (!text || !name) return;
  var sheet = ensureRequestsSheet();
  var last = sheet.getLastRow();
  if (last > 1) {
    // ignore exact repeats from the same person within the latest rows
    var from = Math.max(2, last - 20);
    var recent = sheet.getRange(from, 2, last - from + 1, 2).getValues();
    for (var i = 0; i < recent.length; i++) {
      if (String(recent[i][0]) === name && String(recent[i][1]) === text) return;
    }
  }
  sheet.appendRow([new Date(), sanitizeForSheet(name), sanitizeForSheet(text), "open"]);
  sendEmail("\uD83D\uDCDA File request from " + name, name + " asked for:\n\n" + text + "\n\nSee it in the admin page: Content tab, File requests.");
}

function getFileRequests() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("FileRequests");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var n = sheet.getLastRow() - 1;
  var rows = sheet.getRange(2, 1, n, 4).getValues().map(function (r, i) {
    return { row: i + 2, timestamp: r[0], name: r[1], text: r[2], status: r[3] || "open" };
  }).filter(function (r) { return r.status !== "done"; });
  return rows.reverse().slice(0, 100);
}

function resolveFileRequest(row) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("FileRequests");
  if (!sheet || !row || row < 2 || row > sheet.getLastRow()) return "";
  var text = String(sheet.getRange(row, 3).getValue());
  sheet.getRange(row, 4).setValue("done");
  return "request done: " + text.slice(0, 80);
}

// Recent feedback for the admin dashboard, newest first, plus a
// simple average rating so you don't have to scroll the whole sheet
// to get a feel for where things stand.
function getFeedbackList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Feedback");
  if (!sheet || sheet.getLastRow() < 2) return { entries: [], averageRating: null, count: 0 };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues()
    .map(function (r) { return { timestamp: r[0], name: r[1], email: r[2], rating: Number(r[3]) || null, improvements: r[4], suggestion: r[5] }; })
    .reverse();
  var rated = rows.filter(function (r) { return r.rating; });
  var avg = rated.length ? (rated.reduce(function (s, r) { return s + r.rating; }, 0) / rated.length) : null;
  return { entries: rows.slice(0, 100), averageRating: avg ? Math.round(avg * 10) / 10 : null, count: rows.length };
}

function logAdminAction(action, detail) {
  try {
    ensureAdminActionsSheet().appendRow([new Date(), action, sanitizeForSheet(detail || "")]);
  } catch (e) {
    // Never let audit logging itself break the action it's logging.
  }
}

function readAdminActionRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("AdminActions");
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
    .map(function (r) { return { timestamp: r[0], action: r[1], detail: r[2] }; });
}

function getAdminActionLog() {
  var rows = readAdminActionRows();
  return rows.slice(Math.max(0, rows.length - 100)).reverse();
}

// Most recent admin action taken directly against each person, keyed
// by normalized name — for the "last admin action" column on the
// roster, so you can tell at a glance whether you've already dealt
// with someone without opening their detail view. Only actions that
// clearly name ONE person are counted (approve/reject/suspend/
// unsuspend/setExpiry) — broadcast-style actions like sendMessage or
// archiveOldLogs aren't about a specific person, so they're excluded.
function getLastAdminActionByName() {
  var rows = readAdminActionRows().sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  var directActions = { approveName: 1, rejectName: 1, suspendIdentity: 1, unsuspendIdentity: 1 };
  var map = {};
  rows.forEach(function (r) {
    var name = null;
    if (directActions[r.action]) {
      name = r.detail;
    } else if (r.action === "setExpiry") {
      name = String(r.detail).split(" -> ")[0];
    }
    if (!name) return;
    var norm = normalizeNameGS(name);
    if (!map[norm]) map[norm] = { action: r.action, timestamp: r.timestamp };
  });
  return map;
}

function getFlags(rows) {
  rows = rows || readLogRows();
  var aliasInfo = getAliasInfo();

  function groupKeyFor(rawName) {
    var norm = normalizeNameGS(rawName);
    var id = aliasInfo.aliasToIdentity[norm];
    return id ? ("id:" + id) : ("raw:" + norm);
  }

  var deviceEvents = {};
  var nameAttempts = {};
  var viewEvents = {};

  rows.forEach(function (r) {
    if (r.type === "login" && r.name) {
      var norm = normalizeNameGS(r.name);
      var device = extractField(r.page, "device");
      if (device) {
        if (!deviceEvents[device]) deviceEvents[device] = [];
        deviceEvents[device].push({ norm: norm, ts: r.timestamp });
      }
      if (!nameAttempts[norm]) nameAttempts[norm] = [];
      nameAttempts[norm].push(r.timestamp);
    }
    if ((r.type === "view" || r.type === "download") && r.name) {
      var key = groupKeyFor(r.name);
      if (!viewEvents[key]) viewEvents[key] = [];
      viewEvents[key].push(r.timestamp);
    }
  });

  var TEN_MIN = 10 * 60 * 1000;
  var ONE_MIN = 60 * 1000;
  var FIVE_MIN = 5 * 60 * 1000;

  var deviceCycling = [];
  Object.keys(deviceEvents).forEach(function (device) {
    var events = deviceEvents[device].sort(function (a, b) { return a.ts - b.ts; });
    for (var i = 0; i < events.length; i++) {
      var seen = {};
      for (var j = i; j < events.length && (events[j].ts - events[i].ts) <= TEN_MIN; j++) {
        seen[events[j].norm] = true;
      }
      var distinct = Object.keys(seen);
      if (distinct.length >= 3) {
        deviceCycling.push({ device: device, names: distinct, when: events[i].ts });
        break;
      }
    }
  });

  var rapidRepeat = [];
  Object.keys(nameAttempts).forEach(function (norm) {
    var times = nameAttempts[norm].sort(function (a, b) { return a - b; });
    for (var i = 0; i + 4 < times.length; i++) {
      if ((times[i + 4] - times[i]) <= ONE_MIN) {
        rapidRepeat.push({ name: norm, count: times.length, when: times[i] });
        break;
      }
    }
  });

  var bulkView = [];
  Object.keys(viewEvents).forEach(function (key) {
    var times = viewEvents[key].sort(function (a, b) { return a - b; });
    for (var i = 0; i + 7 < times.length; i++) {
      if ((times[i + 7] - times[i]) <= FIVE_MIN) {
        var isMerged = key.indexOf("id:") === 0;
        var displayName = isMerged ? (aliasInfo.identityCanonical[key.slice(3)] || key.slice(3)) : key.slice(4);
        bulkView.push({ name: displayName, count: times.length, when: times[i] });
        break;
      }
    }
  });

  return { deviceCycling: deviceCycling, rapidRepeat: rapidRepeat, bulkView: bulkView };
}

function isNameActive(rawName) {
  if (!rawName) return false;
  var aliasNorms = resolveAliasSet(rawName);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var presence = ss.getSheetByName("Presence");
  if (!presence || presence.getLastRow() < 2) return false;

  var now = Date.now();
  var rows = presence.getRange(2, 1, presence.getLastRow() - 1, 3).getValues();
  for (var i = 0; i < rows.length; i++) {
    var rName = rows[i][1];
    var lastSeen = rows[i][2] instanceof Date ? rows[i][2].getTime() : 0;
    if (rName && aliasNorms.indexOf(normalizeNameGS(rName)) !== -1 && (now - lastSeen) <= PRESENCE_STALE_MS) {
      return true;
    }
  }
  return false;
}

function getContentStats(rows) {
  rows = rows || readLogRows();
  var byFile = {};

  rows.forEach(function (r) {
    if (!r.detail) return;
    if (r.type !== "view" && r.type !== "view_end" && r.type !== "download") return;
    if (!byFile[r.detail]) {
      byFile[r.detail] = { file: r.detail, views: 0, downloads: 0, seconds: 0, viewers: {} };
    }
    var f = byFile[r.detail];
    if (r.type === "view") { f.views++; if (r.name) f.viewers[normalizeNameGS(r.name)] = true; }
    if (r.type === "download") f.downloads++;
    if (r.type === "view_end" && r.duration) f.seconds += r.duration;
  });

  return Object.keys(byFile)
    .map(function (k) {
      var f = byFile[k];
      return {
        file: f.file,
        views: f.views,
        downloads: f.downloads,
        seconds: Math.round(f.seconds),
        distinctViewers: Object.keys(f.viewers).length
      };
    })
    .sort(function (a, b) { return b.views - a.views; });
}

function getTodayStatsForSession(sessionId) {
  if (!sessionId) return { todaySeconds: 0 };
  var rows = readLogRows();
  var ownerRow = rows.find(function (r) { return r.sessionId === sessionId && r.name; });
  if (!ownerRow) return { todaySeconds: 0 };

  var aliasNorms = resolveAliasSet(ownerRow.name);
  var todayKey = dayKeyGS(new Date());
  var seconds = 0;
  rows.forEach(function (r) {
    if (r.type === "view_end" && r.duration && r.name &&
        aliasNorms.indexOf(normalizeNameGS(r.name)) !== -1 &&
        dayKeyGS(r.timestamp) === todayKey) {
      seconds += r.duration;
    }
  });
  return { todaySeconds: Math.round(seconds) };
}

// Which files this identity has ever opened, plus per-file total time
// — the raw material for the student-facing "My Progress" page.
// Scoped by sessionId exactly like getTodayStatsForSession above, for
// the same reason: nobody should be able to read anyone else's
// progress just by knowing their name. The actual subject/folder
// structure (which files belong to which subject) only exists in
// config.js, client-side — this just hands back "here's everything
// you've opened and for how long", and script.js cross-references it
// against SITE_CONFIG itself to build the per-subject breakdown.
function getMyProgressForSession(sessionId) {
  if (!sessionId) return { viewedFiles: [] };
  var rows = readLogRows();
  var ownerRow = rows.find(function (r) { return r.sessionId === sessionId && r.name; });
  if (!ownerRow) return { viewedFiles: [] };

  var aliasNorms = resolveAliasSet(ownerRow.name);
  var seconds = {};
  var seen = {};
  rows.forEach(function (r) {
    if (!r.name || !r.detail) return;
    if (aliasNorms.indexOf(normalizeNameGS(r.name)) === -1) return;
    if (r.type === "view") seen[r.detail] = true;
    if (r.type === "view_end" && r.duration) seconds[r.detail] = (seconds[r.detail] || 0) + r.duration;
  });

  return {
    viewedFiles: Object.keys(seen).map(function (file) {
      return { file: file, seconds: Math.round(seconds[file] || 0) };
    })
  };
}

function getUnauthorizedQueue(rows) {
  var accessHashes = readFirstColumn("AccessList").concat(STATIC_ACCESS_HASHES);
  var rejectedNorms = getRejectedNamesArr();
  var byNorm = {};

  function add(name, norm, ts, email) {
    if (!byNorm[norm]) byNorm[norm] = { name: name, norm: norm, count: 0, lastAttempt: ts, email: "" };
    var q = byNorm[norm];
    q.count++;
    if (ts && (!q.lastAttempt || ts > q.lastAttempt)) { q.lastAttempt = ts; q.name = name; }
    if (email && !q.email) q.email = email;
  }

  // 1) The dedicated requests sheet (everything since it was added).
  var sheetRows = readApprovalRequests();
  var cutoff = Infinity;
  sheetRows.forEach(function (r) {
    var t = r.timestamp instanceof Date ? r.timestamp.getTime() : 0;
    if (t && t < cutoff) cutoff = t;
    add(r.name, r.norm, r.timestamp, r.email);
  });

  // 2) Older requests that only exist in the Log (before the sheet).
  (rows || readLogTail(4000)).forEach(function (r) {
    if (r.type !== "login" || r.detail !== "approval_requested" || !r.name) return;
    var t = r.timestamp instanceof Date ? r.timestamp.getTime() : 0;
    if (t && t >= cutoff - 5000) return; // already counted from the sheet
    add(r.name, normalizeNameGS(r.name), r.timestamp, extractField(r.page, "email"));
  });

  return Object.keys(byNorm)
    .map(function (norm) { return byNorm[norm]; })
    .filter(function (q) { return accessHashes.indexOf(sha256HexGS(PORTAL_SALT + q.norm)) === -1; })
    .filter(function (q) { return rejectedNorms.indexOf(q.norm) === -1; })
    .sort(function (a, b) { return new Date(b.lastAttempt) - new Date(a.lastAttempt); })
    .slice(0, 100);
}

function archiveOldLogs(days) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Log");
  if (!sheet || sheet.getLastRow() < 2) return { archived: 0 };

  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var lastCol = Math.max(sheet.getLastColumn(), 8);
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var toArchive = [];
  var toKeep = [];
  values.forEach(function (r) {
    var t = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
    if (t && t < cutoff) toArchive.push(r); else toKeep.push(r);
  });

  if (toArchive.length) {
    var archiveSheet = ss.getSheetByName("LogArchive");
    if (!archiveSheet) {
      archiveSheet = ss.insertSheet("LogArchive");
      archiveSheet.appendRow(["Timestamp", "Type", "Name", "Detail", "Page", "SessionId", "ViewId", "DurationSeconds"]);
      archiveSheet.setFrozenRows(1);
    }
    archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, toArchive.length, lastCol).setValues(toArchive);

    sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (toKeep.length) sheet.getRange(2, 1, toKeep.length, lastCol).setValues(toKeep);
  }

  return { archived: toArchive.length, kept: toKeep.length };
}

// Counts only - nothing is moved. Lets the admin see what archiving would do.
function archivePreview(days) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Log");
  if (!sheet || sheet.getLastRow() < 2) return { total: 0, wouldArchive: 0, wouldKeep: 0, days: days };
  var times = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var old = 0;
  times.forEach(function (r) {
    var t = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
    if (t && t < cutoff) old++;
  });
  return { total: times.length, wouldArchive: old, wouldKeep: times.length - old, days: days };
}

// Numbers for the admin Overview: 14-day activity, files opened today, log size.
function getOverview(rows) {
  rows = rows || readLogRows();
  var DAYS = 14;
  var keys = [], idx = {}, stamps = [];
  for (var i = DAYS - 1; i >= 0; i--) {
    var dayDate = new Date(Date.now() - i * 86400000);
    var k = dayKeyGS(dayDate);
    idx[k] = keys.length;
    keys.push(k);
    stamps.push(dayDate.getTime());
  }
  var views = keys.map(function () { return 0; });
  var people = keys.map(function () { return {}; });
  var todayKey = keys[keys.length - 1];
  var filesToday = 0;
  rows.forEach(function (r) {
    if (r.type !== "view" && r.type !== "login") return;
    var dk = dayKeyGS(r.timestamp);
    var j = idx[dk];
    if (j === undefined) return;
    if (r.type === "view") {
      views[j]++;
      if (dk === todayKey) filesToday++;
    }
    if (r.name) people[j][normalizeNameGS(r.name)] = true;
  });
  return {
    activity: keys.map(function (k, n) { return { day: k, ts: stamps[n], views: views[n], people: Object.keys(people[n]).length }; }),
    filesToday: filesToday,
    logRows: rows.length
  };
}

// ═══════════════════════════════════════════════════════════════
//  WHAT GETS WRITTEN TO THE LOG (and what doesn't)
//  Written:  logins (allowed / refused), which home screen or subject
//            someone opens, a PDF or practical that was ACTUALLY opened
//            (and how long it was open), and when a visit ends.
//  Not written: file downloads the Cloudflare Worker reports (every
//            thumbnail/preview made one), "session started" rows, the
//            folder someone clicked inside a subject, and PDF views
//            shorter than 3 seconds.
// ═══════════════════════════════════════════════════════════════
function shouldRecordEvent(data) {
  var type = data.type || "";
  var detail = String(data.detail || "");
  if (type === "download") return false;
  if (type === "session_start") return false;
  if (type === "navigate" && detail.indexOf("folder:") === 0) return false;
  if (type === "view_end" && data.duration !== undefined && data.duration !== "" && Number(data.duration) < 3) return false;
  return true;
}

// Same rules, applied to a row that is already in the sheet.
function isNoiseRow(r) {
  var type = String(r[1] || ""), detail = String(r[3] || "");
  if (type === "download" || type === "session_start") return true;
  if (type === "navigate" && detail.indexOf("folder:") === 0) return true;
  if (type === "view_end" && r[7] !== "" && r[7] !== null && r[7] !== undefined && Number(r[7]) < 3) return true;
  if (type === "login" && !detail) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
//  ONE-CLICK SHEET TIDY-UP
//  Run it from the sheet's "Portal" menu, from the admin page
//  (Security → Housekeeping), or from the editor (select tidySheet → Run).
//  It is safe to run again: nothing is deleted. A copy of the Log is
//  kept first, and removed rows go to the LogArchive tab.
// ═══════════════════════════════════════════════════════════════
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu("Portal")
      .addItem("Tidy up this sheet", "tidySheetFromMenu")
      .addItem("Refresh the Summary tab", "refreshSummaryFromMenu")
      .addToUi();
  } catch (e) { /* menu is a convenience only */ }
}

function tidySheetFromMenu() {
  var report = tidySheet();
  try { SpreadsheetApp.getUi().alert("Sheet tidied up:\n\n" + report.join("\n")); } catch (e) {}
}

function refreshSummaryFromMenu() {
  buildSummarySheet(SpreadsheetApp.getActiveSpreadsheet());
  try { SpreadsheetApp.getActiveSpreadsheet().toast("Summary refreshed."); } catch (e) {}
}

var TAB_STYLE = {
  Guide:            { color: "#c9a15a", widths: [190, 640] },
  Summary:          { color: "#c9a15a" },
  Log:              { color: "#6f93ab", widths: [150, 110, 160, 280, 260, 120, 120, 80], dates: [1], filter: true, headers: ["Time", "Event", "Person", "What", "Where / device trace", "Visit ID", "View ID", "Seconds"] },
  ApprovalRequests: { color: "#8fa07b", widths: [150, 170, 240, 150, 220], dates: [4], filter: true },
  Feedback:         { color: "#8fa07b", widths: [150, 160, 240, 70, 200, 420], dates: [1], filter: true },
  FileRequests:     { color: "#8fa07b", widths: [150, 160, 420, 90], dates: [1], filter: true },
  AccessList:       { color: "#8fa07b", widths: [330, 200, 150], dates: [3], filter: true },
  Identities:       { color: "#8fa07b", widths: [300, 220, 90, 150], dates: [4], filter: true },
  Aliases:          { color: "#8fa07b", widths: [220, 300], filter: true },
  Catalog:          { color: "#b06349", widths: [110, 200, 320, 420, 150], dates: [5], filter: true },
  AdminActions:     { color: "#b06349", widths: [150, 190, 480], dates: [1], filter: true },
  RejectedNames:    { color: "#888888", widths: [200, 200, 150], dates: [3] },
  SuspendedNames:   { color: "#888888", widths: [330, 150], dates: [2] },
  BlockedDevices:   { color: "#888888", widths: [330, 150, 240], dates: [2] },
  ActiveSessions:   { color: "#555555", widths: [200, 300, 150], dates: [3], hide: true },
  Presence:         { color: "#555555", widths: [300, 200, 150, 160, 150], dates: [3, 5], hide: true },
  Commands:         { color: "#555555", widths: [300, 300, 100, 150], dates: [4], hide: true },
  ProtectedAccounts:{ color: "#555555", widths: [200, 300, 150], dates: [3], hide: true },
  LogArchive:       { color: "#555555", widths: [150, 110, 160, 280, 260, 120, 120, 80], dates: [1], headers: ["Time", "Event", "Person", "What", "Where / device trace", "Visit ID", "View ID", "Seconds"] }
};
var TAB_ORDER = ["Guide", "Summary", "Log", "ApprovalRequests", "Feedback", "FileRequests", "AccessList", "Identities", "Aliases", "Catalog", "AdminActions",
  "RejectedNames", "SuspendedNames", "BlockedDevices", "LogArchive", "ActiveSessions", "Presence", "Commands", "ProtectedAccounts"];

function tidySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    report.push(moveNoiseFromLog(ss));
    ensureLogSheet();
    TAB_ORDER.forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (sh) { try { styleTab(sh, TAB_STYLE[name] || {}); } catch (e) { report.push(name + ": style skipped (" + e + ")"); } }
    });
    buildGuideSheet(ss);
    buildSummarySheet(ss);
    orderTabs(ss);
    // Hide the behind-the-scenes tabs last (the active tab can't be hidden).
    TAB_ORDER.forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (sh && TAB_STYLE[name] && TAB_STYLE[name].hide) { try { sh.hideSheet(); } catch (e) {} }
    });
    report.push("Tabs tidied, ordered and colour-coded; technical tabs hidden.");
  } finally {
    lock.releaseLock();
  }
  invalidateCaches();
  return report;
}

// Backs up the Log, moves noise rows to LogArchive, trims the Page column.
function moveNoiseFromLog(ss) {
  var log = ss.getSheetByName("Log");
  if (!log || log.getLastRow() < 2) return "Log was already empty.";
  var lastCol = Math.max(log.getLastColumn(), 8);
  var n = log.getLastRow() - 1;
  var values = log.getRange(2, 1, n, lastCol).getValues();

  var keep = [], noise = [];
  values.forEach(function (r) {
    if (!r[0] && !r[1]) return; // blank row
    if (isNoiseRow(r)) { noise.push(r); return; }
    // The long page address only matters on login rows (it holds the device trace).
    if (String(r[1]) !== "login") r[4] = "";
    keep.push(r);
  });
  if (!noise.length && keep.length === values.length) {
    var unchanged = values.every(function (r, i) { return r[4] === keep[i][4]; });
    if (unchanged) return "Log was already tidy (" + keep.length + " rows).";
  }

  // 1. Backup copy of the whole Log, just in case.
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd MMM HH:mm");
  var backup = log.copyTo(ss);
  try { backup.setName("Log backup " + stamp); } catch (e) { /* name already used - fine */ }
  backup.setTabColor("#555555");

  // 2. Noise rows go to LogArchive (nothing is deleted).
  if (noise.length) {
    var arch = ss.getSheetByName("LogArchive");
    if (!arch) {
      arch = ss.insertSheet("LogArchive");
      arch.appendRow(["Timestamp", "Type", "Name", "Detail", "Page", "SessionId", "ViewId", "DurationSeconds"]);
      arch.setFrozenRows(1);
    }
    arch.getRange(arch.getLastRow() + 1, 1, noise.length, lastCol).setValues(noise);
  }

  // 3. Rewrite the Log with only what matters.
  log.getRange(2, 1, n, lastCol).clearContent();
  if (keep.length) log.getRange(2, 1, keep.length, lastCol).setValues(keep);
  _logRowsMemo = null;
  return "Log: kept " + keep.length + " important rows, moved " + noise.length + " noise rows to LogArchive (full copy saved as 'Log backup " + stamp + "').";
}

function styleTab(sh, st, skipHeaderRow) {
  if (!sh) return;
  st = st || {};
  var lastRow = Math.max(sh.getLastRow(), 1);
  var lastCol = Math.max(sh.getLastColumn(), 1);

  // Remove the thousands of empty padding rows Google adds.
  var maxRows = sh.getMaxRows();
  if (maxRows > lastRow + 50) sh.deleteRows(lastRow + 51, maxRows - lastRow - 50);

  sh.setTabColor(st.color || "#888888");
  var all = sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), lastCol));
  all.setFontFamily("Arial").setFontSize(10).setVerticalAlignment("middle");

  if (!skipHeaderRow) {
    if (st.headers) sh.getRange(1, 1, 1, st.headers.length).setValues([st.headers]);
    sh.getRange(1, 1, 1, lastCol).setBackground("#121218").setFontColor("#f4f1e8").setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  if (st.widths) st.widths.forEach(function (w, i) { if (i < sh.getMaxColumns()) sh.setColumnWidth(i + 1, w); });
  (st.dates || []).forEach(function (c) {
    if (c <= sh.getMaxColumns() && sh.getMaxRows() > 1) sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat("dd mmm yyyy, hh:mm").setHorizontalAlignment("left");
  });
  if (st.filter && lastRow > 1) {
    try {
      if (sh.getFilter()) sh.getFilter().remove();
      sh.getRange(1, 1, lastRow, lastCol).createFilter();
    } catch (e) { /* filter is optional */ }
  }
  if (sh.getName() === "Log") {
    var rules = [
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR($D2="unauthorized",$D2="suspended",$D2="abusive",$D2="concurrent_blocked")')
        .setBackground("#f6dcd5").setRanges([sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 8)]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$B2="view"')
        .setBackground("#e6efdc").setRanges([sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 8)]).build()
    ];
    sh.setConditionalFormatRules(rules);
  }
}

function orderTabs(ss) {
  var pos = 1;
  TAB_ORDER.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
  });
  var first = ss.getSheetByName("Guide") || ss.getSheetByName("Summary");
  if (first) ss.setActiveSheet(first);
}

function buildGuideSheet(ss) {
  var sh = ss.getSheetByName("Guide") || ss.insertSheet("Guide");
  sh.clear();
  var rows = [
    ["Class 12 Study Portal — what is in this sheet", ""],
    ["", ""],
    ["Summary", "Live tables: most-opened PDFs, reading time, busiest people and days. Updates by itself."],
    ["Log", "The activity record. Only important things are kept: logins, the home screen / subject someone opens, each PDF or practical actually opened, and how long it stayed open."],
    ["ApprovalRequests", "People who asked for access and are waiting for you (managed from the admin page)."],
    ["Feedback", "Ratings and suggestions sent from the site."],
    ["AccessList", "Everyone who is allowed in. (Stored as codes, so names can't be read from the website.)"],
    ["Identities / Aliases", "Which names belong to the same person after you merge them."],
    ["FileRequests", "Files students asked you to add (also shown in the admin page, Content tab)."],
    ["Catalog", "The list of PDFs shown on the site (kept up to date by Scan / Sync in the admin page)."],
    ["AdminActions", "A history of what you did in the admin page."],
    ["RejectedNames, SuspendedNames, BlockedDevices", "Lists used for blocking. Change them from the admin page, not here."],
    ["LogArchive", "Old or unimportant log rows moved out of the Log. Nothing is deleted."],
    ["Hidden tabs", "ActiveSessions, Presence, Commands, ProtectedAccounts are used by the site behind the scenes. Right-click a tab strip → Show hidden sheets if you ever need them."],
    ["", ""],
    ["Menu: Portal", "Tidy up this sheet  /  Refresh the Summary tab. Tidying is safe to repeat; a backup copy of the Log is saved first."],
    ["Please", "Don't rename or reorder columns, and don't type inside the hidden or code-like tabs. The site reads them by position."]
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1).setFontSize(16).setFontWeight("bold");
  sh.getRange(3, 1, rows.length - 2, 1).setFontWeight("bold");
  sh.getRange(1, 1, rows.length, 2).setWrap(true).setVerticalAlignment("top").setFontFamily("Arial");
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 640);
  sh.setTabColor("#c9a15a");
}

function buildSummarySheet(ss) {
  var sh = ss.getSheetByName("Summary") || ss.insertSheet("Summary");
  sh.clear();
  var src = "Log!A2:H";
  function q(query, headerWord) { return "=IFERROR(QUERY(" + src + ",\"" + query + "\",0),\"Nothing yet\")"; }
  var blocks = [
    { col: 1, title: "Most-opened PDFs / practicals", f: q("select D, count(A) where B = 'view' and D <> '' group by D order by count(A) desc label D 'PDF or practical', count(A) 'Times opened'") },
    { col: 4, title: "Reading time per PDF / practical (minutes)", f: q("select D, sum(H)/60 where B = 'view_end' and D <> '' group by D order by sum(H)/60 desc label D 'PDF or practical', sum(H)/60 'Minutes'") },
    { col: 7, title: "PDFs opened per person", f: q("select C, count(A) where B = 'view' and C <> '' group by C order by count(A) desc label C 'Person', count(A) 'PDFs opened'") },
    { col: 10, title: "Reading time per person (minutes)", f: q("select C, sum(H)/60 where B = 'view_end' and C <> '' group by C order by sum(H)/60 desc label C 'Person', sum(H)/60 'Minutes'") },
    { col: 13, title: "PDFs opened per day", f: q("select toDate(A), count(A) where B = 'view' group by toDate(A) order by toDate(A) desc label toDate(A) 'Day', count(A) 'PDFs opened'") },
    { col: 16, title: "Screens visited", f: q("select D, count(A) where B = 'navigate' and D <> '' group by D order by count(A) desc label D 'Screen', count(A) 'Visits'") }
  ];
  sh.getRange(1, 1).setValue("Summary — updates by itself from the Log");
  sh.getRange(1, 1).setFontSize(16).setFontWeight("bold");
  blocks.forEach(function (b) {
    sh.getRange(3, b.col).setValue(b.title).setFontWeight("bold").setBackground("#121218").setFontColor("#f4f1e8");
    sh.getRange(3, b.col + 1).setBackground("#121218");
    sh.getRange(4, b.col).setFormula(b.f);
    sh.setColumnWidth(b.col, 260);
    sh.setColumnWidth(b.col + 1, 110);
    sh.setColumnWidth(b.col + 2, 24);
  });
  sh.getRange(5, 1, 400, 20).setFontFamily("Arial").setFontSize(10);
  sh.getRange(5, 13, 400, 1).setNumberFormat("dd mmm yyyy");
  [5, 11].forEach(function (c) { sh.getRange(5, c, 400, 1).setNumberFormat("0.0"); });
  sh.getRange(5, 5, 400, 1).setNumberFormat("0.0");
  sh.getRange(5, 11, 400, 1).setNumberFormat("0.0");
  sh.setFrozenRows(3);
  sh.setHiddenGridlines(true);
  sh.setTabColor("#c9a15a");
}

function mapLogValues(values) {
  return values.map(function (r) {
    return {
      timestamp: r[0],
      type: r[1] || "",
      name: r[2] || "",
      detail: r[3] || "",
      page: r[4] || "",
      sessionId: r[5] || "",
      viewId: r[6] || "",
      duration: (r[7] === "" || r[7] === undefined) ? null : Number(r[7])
    };
  });
}

var _logRowsMemo = null;
function readLogRows() {
  // Remembered for the rest of THIS request so several admin sections
  // never re-read the whole sheet.
  if (_logRowsMemo) return _logRowsMemo;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Log");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), 8);
  _logRowsMemo = mapLogValues(sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues());
  return _logRowsMemo;
}

// Only the most recent n rows (fast even when the Log is huge).
function readLogTail(n) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Log");
  if (!sheet) return [];
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - n + 1);
  var lastCol = Math.max(sheet.getLastColumn(), 8);
  return mapLogValues(sheet.getRange(start, 1, last - start + 1, lastCol).getValues());
}

function getAdminSummary(rows) {
  rows = rows || readLogRows();
  var aliasInfo = getAliasInfo();
  var suspendedHashes = getSuspendedHashesArr();
  var expiryMap = getExpiryMap();
  var lastActionMap = getLastAdminActionByName();
  var pinsMap = pinKeysSet();
  var byGroup = {};
  var allFilesEverSeen = {};

  function groupKeyFor(rawName) {
    var norm = normalizeNameGS(rawName);
    var id = aliasInfo.aliasToIdentity[norm];
    return id ? ("id:" + id) : ("raw:" + norm);
  }

  rows.forEach(function (r) {
    if (!r.name) return;
    var key = groupKeyFor(r.name);
    if (!byGroup[key]) {
      byGroup[key] = {
        rawNames: {},
        lastSeen: r.timestamp,
        totalViewSeconds: 0,
        loginCount: 0,
        unauthorizedCount: 0,
        fileSeconds: {},
        fileCounts: {},
        filesSeen: {},
        sessions: {},
        legacyDays: {}
      };
    }
    var p = byGroup[key];
    p.rawNames[r.name] = true;
    if (r.timestamp > p.lastSeen) p.lastSeen = r.timestamp;

    if ((r.type === "view" || r.type === "download") && r.detail) {
      p.filesSeen[r.detail] = true;
      allFilesEverSeen[r.detail] = true;
    }

    if (r.sessionId) {
      var s = p.sessions[r.sessionId];
      if (!s) s = p.sessions[r.sessionId] = { first: r.timestamp, last: r.timestamp, explicitDuration: null };
      if (r.timestamp < s.first) s.first = r.timestamp;
      if (r.timestamp > s.last) s.last = r.timestamp;
      if (r.type === "session_end" && r.duration) s.explicitDuration = r.duration;
    } else {
      var dkey = dayKeyGS(r.timestamp);
      if (!p.legacyDays[dkey]) p.legacyDays[dkey] = { first: r.timestamp, last: r.timestamp };
      var ld = p.legacyDays[dkey];
      if (r.timestamp < ld.first) ld.first = r.timestamp;
      if (r.timestamp > ld.last) ld.last = r.timestamp;
    }

    if (r.type === "view_end" && r.duration) {
      p.totalViewSeconds += r.duration;
      p.fileSeconds[r.detail] = (p.fileSeconds[r.detail] || 0) + r.duration;
    }
    if (r.type === "view") {
      p.fileCounts[r.detail] = (p.fileCounts[r.detail] || 0) + 1;
    }
    if (r.type === "login") {
      if (r.detail === "authorized") p.loginCount++;
      if (r.detail === "unauthorized") p.unauthorizedCount++;
    }
  });

  return Object.keys(byGroup).map(function (key) {
    var p = byGroup[key];
    var sessionCount = 0;
    var totalSessionSeconds = 0;

    Object.keys(p.sessions).forEach(function (sid) {
      var s = p.sessions[sid];
      sessionCount++;
      totalSessionSeconds += s.explicitDuration != null ? s.explicitDuration : Math.max(0, (s.last - s.first) / 1000);
    });
    Object.keys(p.legacyDays).forEach(function (dkey) {
      var ld = p.legacyDays[dkey];
      sessionCount++;
      totalSessionSeconds += Math.max(0, (ld.last - ld.first) / 1000);
    });

    var isMerged = key.indexOf("id:") === 0;
    var identityId = isMerged ? key.slice(3) : null;
    var rawNameList = Object.keys(p.rawNames);
    var canonicalName = isMerged ? (aliasInfo.identityCanonical[identityId] || rawNameList[0]) : rawNameList[0];
    var aliasList = rawNameList.filter(function (n) { return n !== canonicalName; });

    var aliasNorms = isMerged ? aliasInfo.identityAliases[identityId] : [normalizeNameGS(canonicalName)];
    var suspended = aliasNorms.some(function (norm) {
      return suspendedHashes.indexOf(sha256HexGS(PORTAL_SALT + norm)) !== -1;
    });

    var expiresAt = null;
    aliasNorms.forEach(function (norm) {
      if (expiryMap[norm] && !expiresAt) expiresAt = expiryMap[norm];
    });

    var lastAction = null;
    aliasNorms.forEach(function (norm) {
      var a = lastActionMap[norm];
      if (a && (!lastAction || new Date(a.timestamp) > new Date(lastAction.timestamp))) lastAction = a;
    });

    var topFiles = Object.keys(p.fileSeconds)
      .map(function (f) { return { file: f, seconds: Math.round(p.fileSeconds[f]), views: p.fileCounts[f] || 0 }; })
      .sort(function (a, b) { return b.seconds - a.seconds; })
      .slice(0, 8);

    return {
      name: canonicalName,
      aliases: aliasList,
      suspended: suspended,
      hasPin: aliasNorms.some(function (n) { return !!pinsMap[sha256HexGS(PORTAL_SALT + n)]; }),
      expiresAt: expiresAt,
      lastAction: lastAction,
      lastSeen: p.lastSeen,
      sessionCount: sessionCount,
      totalSessionSeconds: Math.round(totalSessionSeconds),
      totalViewSeconds: Math.round(p.totalViewSeconds),
      loginCount: p.loginCount,
      unauthorizedCount: p.unauthorizedCount,
      filesTouched: Object.keys(p.filesSeen).length,
      totalKnownFiles: Object.keys(allFilesEverSeen).length,
      topFiles: topFiles
    };
  }).sort(function (a, b) { return b.lastSeen - a.lastSeen; });
}

function getPersonDetail(name) {
  if (!name) return { events: [], totals: { totalSessionSeconds: 0, totalViewSeconds: 0, sessionCount: 0 } };

  var aliasNorms = resolveAliasSet(name);
  var rows = readLogRows().filter(function (r) {
    return r.name && aliasNorms.indexOf(normalizeNameGS(r.name)) !== -1;
  });

  var totalViewSeconds = 0;
  var sessions = {};
  var legacyDays = {};

  rows.forEach(function (r) {
    if (r.sessionId) {
      var s = sessions[r.sessionId];
      if (!s) s = sessions[r.sessionId] = { first: r.timestamp, last: r.timestamp, explicitDuration: null };
      if (r.timestamp < s.first) s.first = r.timestamp;
      if (r.timestamp > s.last) s.last = r.timestamp;
      if (r.type === "session_end" && r.duration) s.explicitDuration = r.duration;
    } else {
      var dkey = dayKeyGS(r.timestamp);
      if (!legacyDays[dkey]) legacyDays[dkey] = { first: r.timestamp, last: r.timestamp };
      var ld = legacyDays[dkey];
      if (r.timestamp < ld.first) ld.first = r.timestamp;
      if (r.timestamp > ld.last) ld.last = r.timestamp;
    }
    if (r.type === "view_end" && r.duration) totalViewSeconds += r.duration;
  });

  var sessionCount = 0;
  var totalSessionSeconds = 0;
  Object.keys(sessions).forEach(function (sid) {
    var s = sessions[sid];
    sessionCount++;
    totalSessionSeconds += s.explicitDuration != null ? s.explicitDuration : Math.max(0, (s.last - s.first) / 1000);
  });
  Object.keys(legacyDays).forEach(function (dkey) {
    var ld = legacyDays[dkey];
    sessionCount++;
    totalSessionSeconds += Math.max(0, (ld.last - ld.first) / 1000);
  });

  var events = rows
    .sort(function (a, b) { return b.timestamp - a.timestamp; })
    .slice(0, 500)
    .map(function (r) {
      return {
        timestamp: r.timestamp,
        type: r.type,
        detail: r.detail,
        duration: r.duration,
        sessionId: r.sessionId,
        viewId: r.viewId
      };
    });

  return {
    events: events,
    totals: {
      totalSessionSeconds: Math.round(totalSessionSeconds),
      totalViewSeconds: Math.round(totalViewSeconds),
      sessionCount: sessionCount
    }
  };
}

function getPresenceLive() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Presence");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastCol = Math.max(sheet.getLastColumn(), 5);
  var range = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol);
  var values = range.getValues();
  var now = Date.now();
  var keepRows = [];
  var online = [];

  values.forEach(function (r) {
    var lastSeen = r[2] instanceof Date ? r[2].getTime() : 0;
    var isFresh = (now - lastSeen) <= PRESENCE_STALE_MS;
    if (isFresh) {
      keepRows.push(r);
      online.push({
        sessionId: r[0],
        name: r[1] || "",
        lastSeen: r[2],
        currentPage: r[3] || "",
        sessionStart: r[4] || r[2]
      });
    }
  });

  if (keepRows.length !== values.length) {
    sheet.getRange(2, 1, values.length, lastCol).clearContent();
    if (keepRows.length) {
      sheet.getRange(2, 1, keepRows.length, lastCol).setValues(keepRows);
    }
  }

  return online.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
}

function extractField(str, key) {
  if (!str) return "";
  var re = new RegExp(key + ":([^|]+)");
  var m = str.match(re);
  return m ? m[1].trim() : "";
}

function getBlockedDeviceIds() { return cachedRead("c_blocked", function () { return readFirstColumn("BlockedDevices"); }); }

function addBlockedDevice(deviceId, label) {
  deviceId = String(deviceId || "").trim();
  if (!deviceId) return;
  var sheet = ensureSimpleSheet("BlockedDevices", ["DeviceId", "FirstBlockedAt", "DeviceLabel"]);
  var existing = getBlockedDeviceIds().map(function (d) { return String(d || "").trim(); });
  if (existing.indexOf(deviceId) === -1) {
    sheet.appendRow([deviceId, new Date(), sanitizeForSheet(label || "")]);
    invalidateCaches();
  }
}

function getBlockedDevicesFull() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("BlockedDevices");
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
    .map(function (r) { return { deviceId: String(r[0] || "").trim(), firstBlockedAt: r[1], label: r[2] || "" }; })
    .filter(function (r) { return r.deviceId; });
}

function unblockDevice(deviceId) {
  deviceId = String(deviceId || "").trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("BlockedDevices");
  if (!sheet || sheet.getLastRow() < 2) return false;
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "").trim() === deviceId) { sheet.deleteRow(i + 2); invalidateCaches(); return true; }
  }
  return false;
}

function upsertPresence(data) {
  var sessionId = data.sessionId || "";
  if (!sessionId) return;

  var headers = ["SessionId", "Name", "LastSeen", "CurrentPage", "SessionStart"];
  var sheet = ensureSimpleSheet("Presence", headers);
  var lastCol = sheet.getLastColumn();
  if (lastCol < headers.length) {
    sheet.getRange(1, lastCol + 1, 1, headers.length - lastCol).setValues([headers.slice(lastCol)]);
  }

  var now = new Date();
  var lastRow = sheet.getLastRow();
  var rowIndex = -1;
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === sessionId) { rowIndex = i + 2; break; }
    }
  }

  var currentPage = data.detail || data.page || "";

  if (rowIndex === -1) {
    sheet.appendRow([sessionId, sanitizeForSheet(data.name || ""), now, currentPage, now]);
  } else {
    sheet.getRange(rowIndex, 1, 1, 4).setValues([[sessionId, sanitizeForSheet(data.name || ""), now, currentPage]]);
  }
}

function removePresence(sessionId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Presence");
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === sessionId) {
      sheet.deleteRow(i + 2);
      return;
    }
  }
}

function claimActiveSession(rawName, sessionId) {
  var norm = normalizeNameGS(rawName);
  if (!norm) return;
  var sheet = ensureSimpleSheet("ActiveSessions", ["NormalizedName", "SessionId", "Since"]);

  var lastRow = sheet.getLastRow();
  var rowIndex = -1;
  if (lastRow > 1) {
    var names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (names[i][0] === norm) { rowIndex = i + 2; break; }
    }
  }

  if (rowIndex === -1) {
    sheet.appendRow([norm, sessionId, new Date()]);
    return;
  }

  var oldSessionId = sheet.getRange(rowIndex, 2).getValue();
  // Same tab just re-claiming (e.g. a page refresh) — nothing to kick.
  if (oldSessionId && oldSessionId !== sessionId) {
    upsertCommand(oldSessionId, { forceLogout: true });
  }
  sheet.getRange(rowIndex, 1, 1, 3).setValues([[norm, sessionId, new Date()]]);
}

function upsertCommand(sessionId, fields) {
  if (!sessionId) return;
  var headers = ["SessionId", "Message", "ForceLogout", "UpdatedAt"];
  var sheet = ensureSimpleSheet("Commands", headers);

  var lastRow = sheet.getLastRow();
  var rowIndex = -1;
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === sessionId) { rowIndex = i + 2; break; }
    }
  }

  var existing = rowIndex === -1 ? { message: "", forceLogout: false } : {
    message: sheet.getRange(rowIndex, 2).getValue() || "",
    forceLogout: !!sheet.getRange(rowIndex, 3).getValue()
  };
  var message = (fields.message !== undefined) ? fields.message : existing.message;
  var forceLogout = (fields.forceLogout !== undefined) ? fields.forceLogout : existing.forceLogout;

  if (rowIndex === -1) {
    sheet.appendRow([sessionId, message, forceLogout, new Date()]);
  } else {
    sheet.getRange(rowIndex, 1, 1, 4).setValues([[sessionId, message, forceLogout, new Date()]]);
  }
}

function readAndClearCommand(sessionId) {
  if (!sessionId) return { message: "", forceLogout: false };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Commands");
  if (!sheet || sheet.getLastRow() < 2) return { message: "", forceLogout: false };

  var lastRow = sheet.getLastRow();
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === sessionId) {
      var row = sheet.getRange(i + 2, 1, 1, 3).getValues()[0];
      sheet.deleteRow(i + 2);
      return { message: row[1] || "", forceLogout: !!row[2] };
    }
  }
  return { message: "", forceLogout: false };
}

function installDailyDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sendDailyDigest") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sendDailyDigest").timeBased().everyDays(1).atHour(21).create();
}

function sendDailyDigest() {
  if (!NOTIFY_EMAIL || NOTIFY_EMAIL.indexOf("your-email@") === 0) return;

  var since = Date.now() - 24 * 60 * 60 * 1000;
  var rows = readLogRows().filter(function (r) { return r.timestamp && r.timestamp.getTime() >= since; });

  var newLogins = {}, unauthorized = 0, abusive = 0;
  rows.forEach(function (r) {
    if (r.type !== "login") return;
    if (r.detail === "authorized") newLogins[normalizeNameGS(r.name)] = r.name;
    if (r.detail === "unauthorized") unauthorized++;
    if (r.detail === "abusive") abusive++;
  });

  var flags = getFlags();
  var actions = getAdminActionLog().filter(function (a) { return a.timestamp && a.timestamp.getTime() >= since; });

  var lines = [];
  lines.push("Class 12 Portal — last 24 hours");
  lines.push("");
  lines.push(Object.keys(newLogins).length + " people logged in: " + Object.values(newLogins).join(", "));
  lines.push(unauthorized + " unauthorized attempts, " + abusive + " auto-blocked as abusive");
  lines.push("");
  lines.push("Flags: " + flags.deviceCycling.length + " device-cycling, " + flags.rapidRepeat.length + " rapid-repeat, " + flags.bulkView.length + " bulk-view");
  if (actions.length) {
    lines.push("");
    lines.push("Admin actions today:");
    actions.forEach(function (a) { lines.push("  " + a.action + (a.detail ? " — " + a.detail : "")); });
  }

  sendEmail("Class 12 Portal — daily digest", lines.join("\n"));
}

function sendNotification(data) {
  if (!NOTIFY_EMAIL || NOTIFY_EMAIL.indexOf("your-email@") === 0) return;

  var type = data.type || "event";
  if (type !== "login") return;

  var name = data.name || "Someone";
  var detail = data.detail || "";

  var subject, body;
  if (detail === "suspended") {
    subject = "\uD83D\uDEAB Blocked login (suspended): \"" + name + "\"";
    body = "\"" + name + "\" tried to log in and was blocked — name matched the suspended list.\n\nTrace: " + (data.page || "") + "\n\nThis device has been auto-added to BlockedDevices, so it's now blocked under any name too.";
  } else if (detail === "unauthorized") {
    subject = "\u26A0 Unauthorized login attempt: \"" + name + "\"";
    body = "Someone tried to log in as \"" + name + "\" and was NOT on the access list.\n\nTrace: " + (data.page || "");
  } else if (detail === "concurrent_blocked") {
    subject = "\u26A0 Blocked duplicate login: \"" + name + "\"";
    body = "\"" + name + "\" tried to log in while already active in another session.\n\nTrace: " + (data.page || "");
  } else if (detail === "abusive") {
    subject = "\uD83D\uDEAB Auto-blocked abusive login attempt: \"" + name + "\"";
    body = "Someone tried to log in as \"" + name + "\" — the name matched the abuse filter, so the device was auto-blocked immediately, no action needed from you.\n\nTrace: " + (data.page || "");
  } else {
    subject = name + " just logged in — Class 12 Portal";
    body = name + " logged in to the Class 12 study portal just now.";
  }

  sendEmail(subject, body);
}


// ── Student PINs ─────────────────────────────────────────────────
// Optional 4–6 digit PIN per student name. Stored only as a salted
// hash in the "Pins" sheet (NameHash | PinHash | Fails | LockedUntil |
// UpdatedAt). Once a name has a PIN, getPdfToken refuses to hand out
// PDF tokens unless the request carries a valid "trust token" — which
// the server issues only after a correct PIN, and which the browser
// keeps for 30 days so a trusted device isn't asked every time.
var PIN_SALT = "c12-pin-m7Vd2";
var PIN_MAX_FAILS = 5;
var PIN_LOCK_MS = 15 * 60 * 1000;
var PIN_TRUST_MS = 30 * 24 * 60 * 60 * 1000;

function pinSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Pins");
  if (!sh) {
    sh = ss.insertSheet("Pins");
    sh.appendRow(["NameHash", "PinHash", "Fails", "LockedUntil", "UpdatedAt", "Name", "Password"]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < 7) {
    sh.getRange(1, 6, 1, 2).setValues([["Name", "Password"]]); // older sheet: add the columns that let the admin see passwords
  }
  return sh;
}

function pinKeysSet() {
  var arr = cachedRead("c_pins", function () {
    var sh = pinSheet();
    if (sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }).filter(String);
  });
  var set = {};
  arr.forEach(function (k) { set[k] = true; });
  return set;
}

function pinNameKey(name) { return sha256HexGS(PORTAL_SALT + normalizeNameGS(name)); }
function pinHashFor(nameKey, pin) { return sha256HexGS(PIN_SALT + nameKey + String(pin)); }

function findPinRow(sh, nameKey) {
  if (sh.getLastRow() < 2) return 0;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === nameKey) return i + 2;
  return 0;
}

function pinTrustMake(nameKey) {
  var exp = Date.now() + PIN_TRUST_MS;
  var body = "pin|" + nameKey + "|" + exp;
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, TOKEN_SECRET)).replace(/=+$/, "");
  return exp + "." + sig;
}

function verifyPinTrust(name, token) {
  token = String(token || "");
  var dot = token.indexOf(".");
  if (dot < 1) return false;
  var exp = Number(token.slice(0, dot));
  if (!exp || exp < Date.now()) return false;
  var body = "pin|" + pinNameKey(name) + "|" + exp;
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, TOKEN_SECRET)).replace(/=+$/, "");
  return sig === token.slice(dot + 1);
}

function handlePin(data) {
  var name = String(data.name || "");
  if (!name) return { ok: false, error: "missing_params" };
  var key = pinNameKey(name);
  var op = data.op;

  if (op === "state") {
    if (!pinKeysSet()[key]) return { ok: true, state: "none" };
    if (verifyPinTrust(name, data.dt)) return { ok: true, state: "trusted" };
    return { ok: true, state: "required" };
  }

  // Only people who could log in at all may create / test a PIN.
  if (getAccessHashesArr().indexOf(key) === -1 && !STATIC_PROTECTED_ACCOUNTS[normalizeNameGS(name)]) return { ok: false, error: "unauthorized" };
  if (getSuspendedHashesArr().concat(getExpiredHashes()).indexOf(key) !== -1) return { ok: false, error: "suspended" };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: "busy" }; }
  try {
    var sh = pinSheet();
    var row = findPinRow(sh, key);

    if (op === "set") {
      var pin = String(data.pin || "");
      if (pin.length < 4 || pin.length > 32) return { ok: false, error: "bad_pin" };
      if (row) return { ok: false, error: "exists" };
      sh.appendRow([key, pinHashFor(key, pin), 0, 0, new Date(), normalizeNameGS(name), pin]);
      invalidateCaches();
      return { ok: true, dt: pinTrustMake(key) };
    }

    if (op === "check") {
      if (!row) return { ok: true, valid: true, dt: "" };
      var rec = sh.getRange(row, 1, 1, 5).getValues()[0];
      var lockedUntil = Number(rec[3]) || 0;
      if (lockedUntil > Date.now()) return { ok: true, valid: false, locked: Math.ceil((lockedUntil - Date.now()) / 60000) };
      if (String(rec[1]) === pinHashFor(key, String(data.pin || ""))) {
        sh.getRange(row, 3, 1, 2).setValues([[0, 0]]);
        return { ok: true, valid: true, dt: pinTrustMake(key) };
      }
      var fails = (Number(rec[2]) || 0) + 1;
      if (fails >= PIN_MAX_FAILS) {
        sh.getRange(row, 3, 1, 2).setValues([[0, Date.now() + PIN_LOCK_MS]]);
        return { ok: true, valid: false, locked: Math.ceil(PIN_LOCK_MS / 60000) };
      }
      sh.getRange(row, 3).setValue(fails);
      return { ok: true, valid: false, left: PIN_MAX_FAILS - fails };
    }
    return { ok: false, error: "bad_op" };
  } finally {
    lock.releaseLock();
  }
}

function resetPin(name) {
  var key = pinNameKey(name);
  var sh = pinSheet();
  var row = findPinRow(sh, key);
  if (row) sh.deleteRow(row);
  invalidateCaches();
  try { dismissResetRequest(name); } catch (e) {}
  return !!row;
}

// ── Public "studied today" counter ───────────────────────────────
function cachedStat(key, ttl, loader) {
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(key);
    if (hit !== null && hit !== undefined) return JSON.parse(hit);
    var v = loader();
    try { cache.put(key, JSON.stringify(v), ttl); } catch (e) {}
    return v;
  } catch (e) { return loader(); }
}

function getStudiedTodayCount() {
  var today = dayKeyGS(new Date());
  var seen = {};
  var n = 0;
  readLogTail(4000).forEach(function (r) {
    if (!r.name || !(r.timestamp instanceof Date) || dayKeyGS(r.timestamp) !== today) return;
    if (r.type !== "login" && r.type !== "view" && r.type !== "session") return;
    if (r.type === "login" && r.detail !== "authorized") return;
    var k = normalizeNameGS(r.name);
    if (!seen[k]) { seen[k] = 1; n++; }
  });
  return n;
}


// ── Weekly summary email ─────────────────────────────────────────
// Sunday ~8 pm. Turned on/off from the admin page (Content tab); it
// installs or removes its own time trigger.
function weeklyDigestOn() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "sendWeeklyDigest"; });
}

function setWeeklyDigest(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sendWeeklyDigest") ScriptApp.deleteTrigger(t);
  });
  if (on) ScriptApp.newTrigger("sendWeeklyDigest").timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).create();
}

function sendWeeklyDigest(isTest) {
  if (!NOTIFY_EMAIL || NOTIFY_EMAIL.indexOf("your-email@") === 0) return { ok: false, error: "NOTIFY_EMAIL is not set" };
  var now = Date.now(), weekAgo = now - 7 * 86400000;
  var rows = readLogRows();
  var firstSeen = {}, activeWeek = {}, fileViews = {}, viewSeconds = 0;
  rows.forEach(function (r) {
    if (!r.name || !(r.timestamp instanceof Date)) return;
    var t = r.timestamp.getTime(), k = normalizeNameGS(r.name);
    if (r.type === "login" && r.detail === "authorized") {
      if (!firstSeen[k] || t < firstSeen[k].t) firstSeen[k] = { t: t, name: r.name };
    }
    if (t < weekAgo) return;
    if (r.type === "login" && r.detail === "authorized") activeWeek[k] = r.name;
    if (r.type === "view" && r.detail) fileViews[r.detail] = (fileViews[r.detail] || 0) + 1;
    if (r.type === "view_end" && r.duration) viewSeconds += r.duration;
  });
  var newPeople = Object.keys(firstSeen).filter(function (k) { return firstSeen[k].t >= weekAgo; }).map(function (k) { return firstSeen[k].name; });
  var top = Object.keys(fileViews).sort(function (a, b) { return fileViews[b] - fileViews[a]; }).slice(0, 5);
  var quiet = 0;
  try {
    getAdminSummary(rows).forEach(function (p) {
      if (!p.suspended && p.lastSeen instanceof Date && now - p.lastSeen.getTime() > 14 * 86400000) quiet++;
    });
  } catch (err) {}
  var pending = 0;
  try { pending = getUnauthorizedQueue(rows).length; } catch (err) {}

  var L = [];
  L.push("Class 12 Portal — your week" + (isTest ? " (test)" : ""));
  L.push("");
  L.push(Object.keys(activeWeek).length + " students came in this week; " + Math.round(viewSeconds / 3600 * 10) / 10 + " hours spent reading PDFs.");
  L.push(newPeople.length ? ("New this week (" + newPeople.length + "): " + newPeople.slice(0, 15).join(", ")) : "No brand-new students this week.");
  L.push("");
  L.push("Most-read files:");
  if (!top.length) L.push("  (none yet)");
  top.forEach(function (f, i) { L.push("  " + (i + 1) + ". " + f + " — " + fileViews[f] + " views"); });
  L.push("");
  L.push(quiet + " approved students haven't visited in 2+ weeks.");
  L.push(pending + " access requests waiting for you.");
  return sendEmail("Class 12 Portal — weekly summary", L.join("\n"));
}


// ── Admin: see / change a student's password ─────────────────────
// The Pins sheet keeps the password text (column G) next to the hash
// used for checking, so the admin page can show it. Passwords chosen
// before this version only have the hash — those show as "unknown"
// until the admin sets one (or the student re-creates it).
function adminGetPassword(name) {
  var sh = pinSheet();
  var norms = resolveAliasSet(name);
  for (var i = 0; i < norms.length; i++) {
    var row = findPinRow(sh, sha256HexGS(PORTAL_SALT + norms[i]));
    if (row) {
      var rec = sh.getRange(row, 1, 1, 7).getValues()[0];
      return { hasPassword: true, password: String(rec[6] || ""), known: !!rec[6], locked: (Number(rec[3]) || 0) > Date.now() };
    }
  }
  return { hasPassword: false, password: "", known: false, locked: false };
}

function adminSetPassword(name, password) {
  if (!name) return { ok: false, error: "No name given" };
  if (password.length < 4 || password.length > 32) return { ok: false, error: "Password must be 4 to 32 characters" };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: "Busy — try again" }; }
  try {
    var sh = pinSheet();
    var key = pinNameKey(name), row = 0;
    resolveAliasSet(name).forEach(function (n) {
      var k = sha256HexGS(PORTAL_SALT + n), r = findPinRow(sh, k);
      if (r && !row) { row = r; key = k; }
    });
    var vals = [key, pinHashFor(key, password), 0, 0, new Date(), normalizeNameGS(name), password];
    if (row) sh.getRange(row, 1, 1, 7).setValues([vals]); else sh.appendRow(vals);
    invalidateCaches();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}


// ── Progress that follows a student's login ──────────────────────
// Sheet "Progress": NameHash | Data (JSON text) | UpdatedAt (ms).
// Only a request carrying a valid password-session proof ("pt") for
// that exact name may read or write its row.
function handleProgress(data) {
  var name = String(data.name || "");
  if (!name || !verifyPinTrust(name, data.pt)) return { ok: false, error: "auth" };
  var key = pinNameKey(name);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Progress");
  if (!sh) {
    sh = ss.insertSheet("Progress");
    sh.appendRow(["NameHash", "Data", "UpdatedAt", "Name"]);
    sh.setFrozenRows(1);
  }
  var row = findPinRow(sh, key); // same lookup: first column is the name hash

  if (data.op === "get") {
    if (!row) return { ok: true, data: "", ts: 0 };
    var rec = sh.getRange(row, 1, 1, 3).getValues()[0];
    return { ok: true, data: String(rec[1] || ""), ts: Number(rec[2]) || 0 };
  }
  if (data.op === "put") {
    var text = String(data.data || "");
    if (text.length > 45000) return { ok: false, error: "too_big" };
    try { JSON.parse(text); } catch (e) { return { ok: false, error: "bad_data" }; }
    var lock = LockService.getScriptLock();
    try { lock.waitLock(8000); } catch (e) { return { ok: false, error: "busy" }; }
    try {
      var now = Date.now();
      row = findPinRow(sh, key);
      if (row) sh.getRange(row, 2, 1, 2).setValues([[text, now]]);
      else sh.appendRow([key, text, now, normalizeNameGS(name)]);
      return { ok: true, ts: now };
    } finally { lock.releaseLock(); }
  }
  return { ok: false, error: "bad_op" };
}



// ── "Ask admin to reset my password" requests ─────────────────────
// A student who forgot their password taps a button; it lands in the
// admin's Approvals tab. Only names already on the access list can ask,
// and each name can ask once a day.
function ensureResetRequestsSheet() {
  return ensureSimpleSheet("ResetRequests", ["Norm", "Name", "RequestedAt"]);
}

function handlePinReset(data) {
  var name = String(data.name || "").trim();
  if (!name) return { ok: false, error: "missing_params" };
  var key = pinNameKey(name);
  if (getAccessHashesArr().indexOf(key) === -1 && !STATIC_PROTECTED_ACCOUNTS[normalizeNameGS(name)]) return { ok: false, error: "unauthorized" };
  if (getSuspendedHashesArr().concat(getExpiredHashes()).indexOf(key) !== -1) return { ok: false, error: "suspended" };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: "busy" }; }
  try {
    var sh = ensureResetRequestsSheet();
    var norm = normalizeNameGS(name);
    var now = new Date();
    if (sh.getLastRow() >= 2) {
      var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][0]) === norm) {
          var t = vals[i][2] instanceof Date ? vals[i][2].getTime() : 0;
          if (now.getTime() - t < 24 * 3600 * 1000) return { ok: true, already: true };
          sh.getRange(i + 2, 3).setValue(now);
          return { ok: true };
        }
      }
    }
    sh.appendRow([norm, sanitizeForSheet(name), now]);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function readResetRequests() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("ResetRequests");
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().map(function (r) {
    return { norm: String(r[0] || ""), name: String(r[1] || ""), timestamp: r[2] };
  }).filter(function (r) { return r.norm; }).reverse();
}

function dismissResetRequest(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("ResetRequests");
  if (!sh || sh.getLastRow() < 2) return;
  var norm = normalizeNameGS(name);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]) === norm) sh.deleteRow(i + 2);
}

// ── Class revision progress (admin only) ──────────────────────────
// Reads the Progress sheet that students' browsers sync to. Returns
// who has ticked how many files, and how many people ticked each file.
function getClassProgress() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Progress");
  var students = [], perPath = {};
  if (!sh || sh.getLastRow() < 2) return { students: students, perPath: perPath };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  vals.forEach(function (r) {
    var rev = [], focus = 0;
    try { var d = JSON.parse(String(r[1] || "{}")); rev = d.revised || []; focus = Number(d.focus) || 0; } catch (e) { return; }
    var uniq = {};
    rev.forEach(function (p) { if (typeof p === "string") uniq[p] = 1; });
    var paths = Object.keys(uniq);
    paths.forEach(function (p) { perPath[p] = (perPath[p] || 0) + 1; });
    students.push({ name: String(r[3] || ""), revised: paths.length, focus: focus, updated: Number(r[2]) || 0 });
  });
  students.sort(function (a, b) { return b.revised - a.revised; });
  return { students: students, perPath: perPath };
}

// ── Browser errors students hit (admin only) ──────────────────────
function getClientErrors() {
  var rows = readLogTail(4000);
  var groups = {};
  rows.forEach(function (r) {
    if (String(r.type || r[1] || "") !== "client_error") return;
    var detail = String(r.detail !== undefined ? r.detail : r[3] || "");
    var g = groups[detail];
    var t = r.timestamp || r[0];
    var who = String(r.name !== undefined ? r.name : r[2] || "");
    var page = String(r.page !== undefined ? r.page : r[4] || "");
    if (!g) g = groups[detail] = { message: detail, count: 0, people: {}, last: t, page: page };
    g.count++; g.people[who] = 1; g.last = t; g.page = page;
  });
  return Object.keys(groups).map(function (k) {
    var g = groups[k];
    return { message: g.message, count: g.count, people: Object.keys(g.people).length, last: g.last, page: g.page };
  }).sort(function (a, b) { return b.count - a.count; }).slice(0, 25);
}

// ── Weekly backup by email ───────────────────────────────────────
// Emails you ONE zip containing a CSV of every important sheet (people,
// passwords, catalog, progress, etc. — not the big activity Log). If the
// Google Sheet were ever deleted or damaged, everything can be rebuilt
// from the latest email. Uses Gmail only (no extra Google permissions).
var BACKUP_SKIP = { "Log": 1, "LogArchive": 1, "Presence": 1, "Commands": 1, "Summary": 1, "Guide": 1 };

function backupOn() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "sendBackupEmail"; });
}

function setBackup(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sendBackupEmail") ScriptApp.deleteTrigger(t);
  });
  if (on) ScriptApp.newTrigger("sendBackupEmail").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
}

function csvCell(v) {
  if (v instanceof Date) v = v.toISOString();
  var s = String(v === null || v === undefined ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function sendBackupEmail() {
  if (!NOTIFY_EMAIL || NOTIFY_EMAIL.indexOf("your-email@") === 0) return { ok: false, error: "NOTIFY_EMAIL is not set" };
  try {
    var blobs = [], names = [];
    SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
      var nm = sh.getName();
      if (BACKUP_SKIP[nm] || sh.getLastRow() < 1) return;
      var vals = sh.getRange(1, 1, sh.getLastRow(), Math.max(1, sh.getLastColumn())).getValues();
      var csv = vals.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
      blobs.push(Utilities.newBlob(csv, "text/csv", nm + ".csv"));
      names.push(nm);
    });
    if (!blobs.length) return { ok: false, error: "Nothing to back up yet" };
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    var zip = Utilities.zip(blobs, "class12-backup-" + stamp + ".zip");
    if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: "Gmail daily quota used up" };
    MailApp.sendEmail(NOTIFY_EMAIL, "Class 12 Portal — backup " + stamp,
      "Backup of: " + names.join(", ") + ".\n\nKeep the latest one. If the Sheet is ever lost, each CSV can be pasted back into a tab of the same name.\n\nThis email contains student passwords — don't forward it.",
      { name: "Class 12 Portal", attachments: [zip] });
    return { ok: true, sheets: names.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
