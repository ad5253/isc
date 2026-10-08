/* ──────────────────────────────────────────────────────────────
   THE ONLY FILE YOU EDIT TO ADD A NEW PHYSICS EXPERIMENT.

   1. Make a folder:  practicals/physics/<slug>/
   2. Save your finished lab inside it as  index.html
   3. Add one block like the ones below, then upload.

   slug  = the folder name (lowercase, dashes, no spaces)
   num   = experiment number shown on the card
   title = card heading
   blurb = one or two lines of description
   tag   = "3D" or "2D"
   ────────────────────────────────────────────────────────────── */
window.PHYSICS_EXPERIMENTS = [
  {
    slug: "ohms-law",
    num: 1,
    title: "Resistance of a Wire & Ohm's Law",
    blurb: "Find the resistance per unit length of a wire and verify Ohm's law with an ammeter and voltmeter.",
    tag: "3D"
  },
  {
    slug: "resistivity-wheatstone-bridge",
    num: 2,
    title: "Resistivity of a Wire by Wheatstone Bridge",
    blurb: "Measure the wire's diameter with a screw gauge and use the Wheatstone bridge principle to find its resistivity.",
    tag: "3D"
  },
  {
    slug: "combination-of-resistances",
    num: 3,
    title: "Laws of Combination of Resistances",
    blurb: "Verify the series and parallel laws of resistances using a meter bridge.",
    tag: "3D"
  },
  {
    slug: "internal-resistance",
    num: 4,
    title: "Internal Resistance of a Cell",
    blurb: "Use a potentiometer to find the internal resistance of a cell. Wire the circuit, slide the jockey, take readings.",
    tag: "3D"
  }
  // , { slug: "...", num: 5, title: "...", blurb: "...", tag: "3D" }
];
