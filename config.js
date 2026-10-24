// ============================================================
//  STUDY PORTAL — CONFIGURATION
//  Edit this file to change site content & Google Form settings
// ============================================================

const SITE_CONFIG = {

  // ── Site Metadata ──────────────────────────────────────────
  title: "Class 12 Study Portal",
  subtitle: "Complete study material — Notes, Formulas & Solutions",

  // Shown faintly on every PDF page as the watermark (see drawWatermark
  // in script.js) instead of the viewer's name + date.
  siteUrl: "ad5253.github.io/isc",

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
    endpoint: "https://script.google.com/macros/s/AKfycbyC9V40ZEU64kMae9n4zjLiWQdBYPSpG2NdkdIKwIit3vfekSROSXORBaNsQPV47MpP6w/exec",
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
  //  Type your secret phrase into the normal name box (instead of a name) to open the admin page.
  //  Fixes #14 / #17: the phrase is no longer checked here. Nothing about it is stored in this file
  //  any more (the old public hash could be cracked offline). The Cloudflare Worker class12-api-cache
  //  checks it, and wrong guesses lock only the connection that made them.
  admin: {
    enabled: true,
  },
  // ── Access List (who can log in) ─────────────────────────────
  //  Fix #6: the class list is NO LONGER kept in this public file. The server checks one name at a
  //  time. To add a student, use the admin page (Approvals / "Add a name directly").
  accessList: {
    enabled: true,
    salt: "c12-portal-x7q",   // (same as PORTAL_SALT in the Apps Script; never change it)
  },
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
