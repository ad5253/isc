// ============================================================
//  STUDY PORTAL — CONFIGURATION
//  Edit this file to change site content & Google Form settings
// ============================================================

const SITE_CONFIG = {

  // ── Site Metadata ──────────────────────────────────────────
  title: "Class 12 Study Portal",
  subtitle: "Complete study material — Notes, Formulas & Solutions",

  // ── Session ──────────────────────────────────────────────────
  //  After logging in, a name is remembered in the browser (so a
  //  reload doesn't ask again) but only for this many minutes — after
  //  that it auto-expires and the name gate reappears, even if the
  //  page was just sitting open or cached. Set to 0 to require login
  //  on every single visit with no grace period.
  session: {
    expiryMinutes: 15,
  },

  // ── Activity Logging (Login / View / Download) ──────────────
  //  Every login, PDF view, and PDF download is POSTed here in the
  //  background and appended as a row to a Google Sheet — no email
  //  firehose, just a running log you can open any time.
  //  Setup: see google-apps-script.gs (in this folder) for the
  //  script to paste into script.google.com, deploy as a Web App,
  //  then paste the /exec URL below.
  logging: {
    endpoint: "https://script.google.com/macros/s/AKfycbyDtxYLc_dwqKdermC8caK79OG9K4lkIsHA7_XNoFVQDxLX7dmKDp-tCJxOcLOwTJ_7/exec",
  },

  // ── PDF Delivery (Cloudflare Worker → Backblaze B2) ──────────
  //  PDFs are no longer served as static files from this repo — the
  //  `path` values below (e.g. "Physics/Chapter Notes/Ch 1.pdf") are
  //  now just labels the Worker uses to look the file up in the
  //  private B2 bucket. The browser never fetches a file directly;
  //  it asks Apps Script for a short-lived token (see
  //  google-apps-script.gs's getPdfToken addition), then fetches
  //  ${url}?file=<path>&token=<token> from the Worker, which only
  //  returns bytes if that token is genuine and unexpired.
  //
  //  Set this to your deployed Worker's URL, e.g.
  //  "https://class12-pdf-gate.YOURSUBDOMAIN.workers.dev"
  //  (Workers dashboard → your worker → the URL shown at the top).
  //  This is not a secret — it's fine as plain text here, same as
  //  the logging endpoint above; the token is what actually gates
  //  access, not the URL being unlisted.
  pdfWorker: {
    url: "https://class12-pdf-gate.merchantadnan052.workers.dev",
  },

  // ── Admin Dashboard ───────────────────────────────────────────
  //  Typing your secret phrase into the normal name box (instead of
  //  a real name) opens the admin dashboard instead of the student
  //  site. It is NOT on the access list, so it never shows up as a
  //  "student" anywhere in your own logs.
  //
  //  secretHash is a salted SHA-256 hash of that phrase, same model
  //  as accessList above — the real phrase never sits in this file.
  //  To set it: open the live site, open the browser console, run
  //    await __hashAdminSecret("your chosen phrase")
  //  then paste the value it prints below.
  //
  //  SECURITY FIX: this used to also have a plaintext "key" field
  //  here, sent as-is on every admin request. The problem: this file
  //  is publicly downloadable by anyone who visits the site — view
  //  source, or just fetch config.js directly — so that key was never
  //  actually secret, and anyone technical enough to look could have
  //  called every admin endpoint (suspend, approve, force-logout,
  //  broadcast...) without ever knowing your passphrase. Fixed by
  //  having the browser reuse secretHash itself as the request token
  //  once you've typed the correct phrase — it's a one-way hash, safe
  //  to publish, and it's the only thing that needs to match
  //  google-apps-script.gs's ADMIN_KEY now (paste this exact value
  //  there, not a separate short key).
  admin: {
    enabled: true,
    salt: "c12-admin-r4k9",
    secretHash: "66575fc2e3bd47844b7bb501539c9aa1293b85640c9cf094c2c70840b9c21630",
  },

  // ── Protected Accounts (name + password) ─────────────────────
  //  For specific names that need a password on top of the normal
  //  name check — currently Adnan, Kaushal Bhardwaj, Khushbu Bhavsar.
  //  Unlike the access list above, NO password or password hash lives
  //  in this file at all: only the salt (needed so the browser can
  //  hash whatever gets typed before sending it) and the list of
  //  which normalized names require a password prompt. The actual
  //  correct-password check happens on the Apps Script side against
  //  google-apps-script.gs's STATIC_PROTECTED_ACCOUNTS / a
  //  ProtectedAccounts sheet — so unlike the access-list hashes above,
  //  this can't be brute-forced offline just by reading this file;
  //  every guess has to actually hit the live server.
  //  To add someone: add their normalized name (lowercase, single
  //  spaces) to usernames below, then add their username+password
  //  hash to google-apps-script.gs's STATIC_PROTECTED_ACCOUNTS (same
  //  salt, same formula — see the comment there).
  protectedAccounts: {
    salt: "c12-cred-9xQwZaK4",
    usernames: ["adnan", "kaushal", "kaushal bhardwaj", "khushbu", "khushbu bhavsar"],
  },

  // ── Access List (Who Can Log In) ─────────────────────────────
  //  Only names on this list can get past the gate. Matching is
  //  case-insensitive and ignores extra spaces — "PRIYA", "priya",
  //  "  Priya " all match "Priya". Names are stored below as salted
  //  hashes, not plaintext (see note under "hashes"). To add someone,
  //  don't type into this file — open the browser console on the
  //  live site and run:
  //    await __hashName("Their Name")
  //  then paste the value it prints into the hashes array. Set
  //  enabled: false to open the gate back up to anyone.
  accessList: {
    enabled: true,
    // Salted SHA-256 hashes of allowed names (normalized: trimmed,
    // extra spaces collapsed, lowercased) — NOT plaintext, so casually
    // viewing this file doesn't hand out the list of valid names to
    // try. This is obfuscation, not real security: it's still a static
    // site with no server checking anything, so a determined person
    // could brute-force short/common names against these hashes, or
    // just fetch a PDF's direct URL and skip the gate entirely. Treat
    // this as a deterrent against casual snooping, not a lock.
    salt: "c12-portal-x7q",
    hashes: [
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
      "18c157bb3b1ceb49f6a7a44fe5592bfbf38cbaa7a4685774144aeeea7092d5fb", "a0baf5519ca32d4571a263634b437c5d01f6d9dae6dede3ea81a55774e72a1b1", "7f3c302376ff1b99f333c816af32a713928c68d002602481b3bea01c89852e16",
    ],
  },

  // ── Suspended Users ────────────────────────────────────────
  //  Three independent ways someone can get blocked; ANY match is
  //  enough — script.js checks all three before checking accessList.
  //
  //  - hashes:      same salted-hash scheme as accessList, but for
  //                 names to block outright, with `message` shown
  //                 instead of the normal "not authorized" text.
  //                 His name STAYS in accessList.hashes too — this
  //                 list is checked first, so it wins.
  //  - deviceIds:   a fingerprint of the browser/device (not tied to
  //                 any name), computed by script.js. This is what
  //                 catches him if he types a classmate's name on the
  //                 same phone. It starts empty — see script.js's
  //                 getDeviceId() comment for how you get the actual
  //                 value to paste in here once he's logged the
  //                 attempt.
  //  - ips:         his network's public IP address, as a bonus
  //                 layer. Starts empty. IMPORTANT: on mobile data
  //                 this changes every few hours to every few days,
  //                 so this entry will go stale — it's not something
  //                 you set once and forget, unlike deviceIds which
  //                 is stable to that specific browser.
  suspended: {
    enabled: true,
    hashes: [
      // empty — no static suspensions right now. Suspending someone
      // going forward is done from the admin dashboard's Suspend
      // button, which is live and needs no redeploy. Only add
      // something here again if you specifically want a suspension
      // baked into the deployed site itself.
    ],
    deviceIds: [],
    ips: [],
    message: "You have been suspended from using this website due to inappropriate behaviour.",
  },

  // ── Subjects & Files ──────────────────────────────────────
  subjects: [

    // ═══════════════════════  MATHEMATICS  ═══════════════════════
    {
      id: "maths",
      name: "Mathematics",
      icon: "📐",
      color: "#8fa07b",
      subfolders: [
        {
          id: "maths-notes",
          name: "Maths Notes",
          files: [
            { name: "1. Relations and Functions Notes", path: "Maths/Maths Notes/1.Relations and Functions Notes.pdf" },
            { name: "2. Inverse Trigonometric Functions Notes", path: "Maths/Maths Notes/2.Inverse Trignometric Functions Notes.pdf" },
            { name: "3. Matrices Notes", path: "Maths/Maths Notes/3.Matrices Notes.pdf" },
            { name: "4. Determinants Notes", path: "Maths/Maths Notes/4.Determinants Notes.pdf" },
            { name: "5. Differentiability & Continuity Notes", path: "Maths/Maths Notes/5.Differentiability & Continuity Notes.pdf" },
            { name: "6. Applications of Derivatives Notes", path: "Maths/Maths Notes/6.Apllications of derivatives Notes.pdf" },
            { name: "7. Integrals Notes", path: "Maths/Maths Notes/7.Integrals Notes.pdf" },
            { name: "8. Applications of Integrals Notes", path: "Maths/Maths Notes/8.Applications of Integrals Notes.pdf" },
            { name: "9. Differential Equations Notes", path: "Maths/Maths Notes/9.Differential Equations Notes.pdf" },
            { name: "10. Vector Algebra Notes", path: "Maths/Maths Notes/10.Vector Algebra Notes.pdf" },
            { name: "11. Three Dimensional Geometry Notes", path: "Maths/Maths Notes/11.Three Dimensional Geometry Notes.pdf" },
            { name: "12. Linear Programming Notes", path: "Maths/Maths Notes/12.Linear Programming Notes.pdf" },
            { name: "13. Probability Notes", path: "Maths/Maths Notes/13.Probability Notes.pdf" },
          ]
        },
        {
          id: "maths-formulas",
          name: "Maths Formulas",
          files: [
            { name: "1. Relations & Functions Formulas", path: "Maths/Maths Formulas/1.Relations & Functions Formulas.pdf" },
            { name: "2. Inverse Trigonometric Functions Formulas", path: "Maths/Maths Formulas/2.Inverse Trignometric Functions Formulas.pdf" },
            { name: "3. Matrices Formulas", path: "Maths/Maths Formulas/3.Matrices Formulas.pdf" },
            { name: "4. Determinants Formulas", path: "Maths/Maths Formulas/4.Determinants Formulas.pdf" },
            { name: "5. Differentiability and Continuity Formulas", path: "Maths/Maths Formulas/5.Differentiability and Continuity Formulas.pdf" },
            { name: "6. Applications of Derivatives Formulas", path: "Maths/Maths Formulas/6.Applications of Derivatives Formulas.pdf" },
            { name: "7. Integrals Formulas", path: "Maths/Maths Formulas/7.Integrals Formulas.pdf" },
            { name: "8. Applications of Integrals Formulas", path: "Maths/Maths Formulas/8.Applications Of Integrals Formulas.pdf" },
            { name: "Formula List — Chapter 1 to 8", path: "Maths/Maths Formulas/Formula List Chapter 1 to 8.pdf" },
          ]
        },
        {
          id: "maths-solutions",
          name: "Maths Solutions",
          files: [
            { name: "1. Relations & Functions", path: "Maths/Maths Solutions/1.Relations & Functions.pdf" },
            { name: "2. Inverse Trigonometric Functions", path: "Maths/Maths Solutions/2.Inverse Trignometric Functions.pdf" },
            { name: "3. Matrices", path: "Maths/Maths Solutions/3.Matrices.pdf" },
            { name: "4. Determinants", path: "Maths/Maths Solutions/4.Determinants.pdf" },
            { name: "5. Continuity & Differentiability", path: "Maths/Maths Solutions/5.Continuity & Differentiabilty.pdf" },
            { name: "6. Applications of Derivatives", path: "Maths/Maths Solutions/6.Applications of Derivatives.pdf" },
            { name: "7. Integrals", path: "Maths/Maths Solutions/7.Integrals.pdf" },
            { name: "8. Applications of Integrals", path: "Maths/Maths Solutions/8.Applications of Integrals.pdf" },
            { name: "9. Differential Equations", path: "Maths/Maths Solutions/9.Differential Equations.pdf" },
            { name: "10. Vector Algebra", path: "Maths/Maths Solutions/10.Vector Algebra.pdf" },
            { name: "11. Three Dimensional Geometry", path: "Maths/Maths Solutions/11.Three Dimensional Geometry.pdf" },
            { name: "12. Linear Programming", path: "Maths/Maths Solutions/12.Linear Programming.pdf" },
            { name: "13. Probability", path: "Maths/Maths Solutions/13.Probability.pdf" },
            { name: "Volume 1 (Complete)", path: "Maths/Maths Solutions/Volume 1.pdf" },
            { name: "Volume 2 (Complete)", path: "Maths/Maths Solutions/Volume 2.pdf" },
          ]
        },
      ]
    },

    // ═══════════════════════  PHYSICS  ═══════════════════════
    {
      id: "physics",
      name: "Physics",
      icon: "⚛️",
      color: "#6f93ab",
      subfolders: [
        {
          id: "physics-notes",
          name: "Chapter Notes",
          files: [
            { name: "Ch 1 — Electric Charges and Fields", path: "Physics/Chapter Notes/Chapter 1 - Electric Charges and Fields.pdf" },
            { name: "Ch 2 — Electrostatic Potential & Energy", path: "Physics/Chapter Notes/Chapter 2 - Electrostatic Potential Ener.pdf" },
            { name: "Ch 3 — Electric Resistance and Ohm's Law", path: "Physics/Chapter Notes/Chapter 3 - Electric Resistance and Ohms.pdf" },
            { name: "Ch 4 — Moving Charges and Magnetism", path: "Physics/Chapter Notes/Chapter 4 - Moving Charges and Magnetism.pdf" },
            { name: "Ch 5 — Magnetism and Matter", path: "Physics/Chapter Notes/Chapter 5 - Magnetism and Matter.pdf" },
            { name: "Ch 6 — Electromagnetic Induction", path: "Physics/Chapter Notes/Chapter 6 - Electromagnetic Induction.pdf" },
            { name: "Ch 7 — Alternating Current", path: "Physics/Chapter Notes/Chapter 7 - Alternating Current.pdf" },
            { name: "Ch 8 — Electromagnetic Waves", path: "Physics/Chapter Notes/Chapter 8 - Electromagnetic Waves.pdf" },
            { name: "Ch 9 — Ray Optics & Optical Instruments", path: "Physics/Chapter Notes/Chapter 9 - Ray Optics & Optical Instrum(1).pdf" },
          ]
        },
        {
          id: "physics-formulas",
          name: "Physics Formulas",
          files: [
            { name: "01. Electric Fields and Charges Formulas", path: "Physics/Physics Formulas/01. Electric Fields and Charges Formulas.pdf" },
            { name: "02. Electrostatic Potential Formulas", path: "Physics/Physics Formulas/02. Electrostatic Potential Formulas.pdf" },
            { name: "03. Electric Resistance and Ohm's Law Formulas", path: "Physics/Physics Formulas/03. Electric Resistance and Ohms Law Formulas.pdf" },
            { name: "04. Moving Charges and Magnetism Formulas", path: "Physics/Physics Formulas/04. Moving Charges and Magnetism Formulas.pdf" },
            { name: "05. Magnetism and Matter Formulas", path: "Physics/Physics Formulas/05. Magnetism and Matter Formulas.pdf" },
            { name: "06. Electromagnetic Induction Formulas", path: "Physics/Physics Formulas/06. Electromagnetic Induction Formulas.pdf" },
            { name: "07. Alternating Current Formulas", path: "Physics/Physics Formulas/07. Alternating Current Formulas.pdf" },
            { name: "08. Electromagnetic Waves Formulas", path: "Physics/Physics Formulas/08. Electromagnetic Waves Formulas.pdf" },
            { name: "09. Ray Optics and Optical Instruments Formulas", path: "Physics/Physics Formulas/09. Ray Optics and Optical Instruments Formulas.pdf" },
            { name: "10. Wave Optics Formulas", path: "Physics/Physics Formulas/10. Wave Optics Formulas.pdf" },
            { name: "11. Dual Nature of Radiation and Matter Formulas", path: "Physics/Physics Formulas/11. Dual Nature of Radiation and Matter Formulas.pdf" },
            { name: "12. Atoms Formulas", path: "Physics/Physics Formulas/12. Atoms Formulas.pdf" },
            { name: "13. Nuclei Formulas", path: "Physics/Physics Formulas/13. Nuclei Formulas.pdf" },
            { name: "14. Semiconductor Electronics Formulas", path: "Physics/Physics Formulas/14. Semiconductor Electronics Formulas.pdf" },
            { name: "Physics Formulas — Ch 1 to 14 (Complete)", path: "Physics/Physics Formulas/Physics_Formulas_Ch1-14.pdf" },
          ]
        },
        {
          id: "physics-solutions",
          name: "Physics Solutions",
          files: [
            { name: "1. Electric Fields and Charges", path: "Physics/Physics Solutions/1.Electric Fields and charges.pdf" },
            { name: "2. Electrostatic Potential", path: "Physics/Physics Solutions/2.Electrostatic Potential.pdf" },
            { name: "3. Electric Resistance and Ohm's Law", path: "Physics/Physics Solutions/3.Electric Resistance and Ohms Law.pdf" },
            { name: "4. Moving Charges and Magnetism", path: "Physics/Physics Solutions/4.Moving Charges and Magnetism.pdf" },
            { name: "5. Magnetism and Matter", path: "Physics/Physics Solutions/5.Magnetism and Matter.pdf" },
            { name: "6. Electromagnetic Induction", path: "Physics/Physics Solutions/6.Electromagnetic Induction.pdf" },
            { name: "7. Alternating Current", path: "Physics/Physics Solutions/7.Alternating Current.pdf" },
            { name: "8. Electromagnetic Waves", path: "Physics/Physics Solutions/8.Electromagnetic Waves.pdf" },
            { name: "9. Ray Optics and Optical Instruments", path: "Physics/Physics Solutions/9.Ray Optics and Optical Instruments.pdf" },
            { name: "10. Wave Optics", path: "Physics/Physics Solutions/10.Wave Optics.pdf" },
            { name: "11. Dual Nature and Radiation of Matter", path: "Physics/Physics Solutions/11.Dual Nature and Radiation of Matter.pdf" },
            { name: "12. Atoms", path: "Physics/Physics Solutions/12.Atoms.pdf" },
            { name: "13. Nuclei", path: "Physics/Physics Solutions/13.Nuclei.pdf" },
            { name: "14. Semiconductor Electronics", path: "Physics/Physics Solutions/14.Semiconductor Electronics.pdf" },
            { name: "Volume 1 (Complete)", path: "Physics/Physics Solutions/Volume 1.pdf" },
            { name: "Volume 2 (Complete)", path: "Physics/Physics Solutions/Volume 2.pdf" },
          ]
        },
      ]
    },

    // ═══════════════════════  CHEMISTRY  ═══════════════════════
    {
      id: "chemistry",
      name: "Chemistry",
      icon: "🧪",
      color: "#b06349",
      subfolders: [
        {
          id: "chemistry-notes",
          name: "Chapter Notes",
          files: [
            { name: "Ch 1 — Solutions", path: "Chemistry/Chapter Notes/Chapter 1 - Solutions.pdf" },
            { name: "Ch 2 — Electrochemistry", path: "Chemistry/Chapter Notes/Chapter 2 - Electrochemistry.pdf" },
            { name: "Ch 3 — Chemical Kinetics", path: "Chemistry/Chapter Notes/Chapter 3 - Chemical Kinetics.pdf" },
            { name: "Ch 4 — D & F Block Elements", path: "Chemistry/Chapter Notes/Chapter 4 - D & F Block Elements.pdf" },
            { name: "Ch 5 — Coordination Compounds", path: "Chemistry/Chapter Notes/Chapter 5 - Coordination Compounds.pdf" },
            { name: "Ch 6 — Haloalkanes & Haloarenes", path: "Chemistry/Chapter Notes/Chapter 6 - Haloalkanes & Haloarenes.pdf" },
            { name: "Ch 7 — Alcohols, Phenols & Ethers", path: "Chemistry/Chapter Notes/Chapter 7 - Alcohols Phenols & Ethers.pdf" },
            { name: "Ch 10 — Biomolecules", path: "Chemistry/Chapter Notes/Chapter 10 - Biomolecules.pdf" },
        ]
        },
        {
          id: "chemistry-formulas",
          name: "Chemistry Formulas",
          files: [
            { name: "01. Solutions Formulas", path: "Chemistry/Chemistry Formulas/1.Solutions Formulas.pdf" },
            { name: "02. Electrochemistry Formulas", path: "Chemistry/Chemistry Formulas/2.Electrochemistry Formulas.pdf" },
            { name: "03. Chemical Kinetics Formulas", path: "Chemistry/Chemistry Formulas/3.Chemical Kinetics Formulas.pdf" },
            { name: "04. D & F Block Elements Formulas", path: "Chemistry/Chemistry Formulas/4.D & F Block Elements Formulas.pdf" },
            { name: "05. Coordination Compounds Formulas", path: "Chemistry/Chemistry Formulas/5.Coordination Compounds Formulas.pdf" },
            { name: "06. Haloalkanes & Haloarenes Formulas", path: "Chemistry/Chemistry Formulas/6.Haloalkenes & Haloarenes Formulas.pdf" },
            { name: "07. Alcohols, Phenols & Ethers Formulas", path: "Chemistry/Chemistry Formulas/7.Alcohols,Phenols & Ethers Formulas.pdf" },
            { name: "08. Aldehydes, Ketones & Carboxylic Acids Formulas", path: "Chemistry/Chemistry Formulas/8.Aldehydes,Ketones & Carboxylic Acids Formulas.pdf" },
            { name: "09. Organic Compounds Containing Nitrogen Formulas", path: "Chemistry/Chemistry Formulas/9.Organic Compounds Containing Nitrogen Formulas.pdf" },
            { name: "10. Biomolecules Formulas", path: "Chemistry/Chemistry Formulas/10.Biomolecules Formulas.pdf" },
          ]
        },
      ]
    },
  ]
};
