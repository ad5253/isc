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
  },
  {
    slug: "potential-fall-potentiometer",
    num: 5,
    title: "Potential Fall along a Potentiometer Wire",
    blurb: "Set up a potentiometer, slide the jockey along the wire and measure the fall of potential to find the potential gradient.",
    tag: "3D"
  },
  {
    slug: "convex-lens-uv",
    num: 6,
    title: "Focal Length of a Convex Lens (u–v Method)",
    blurb: "Place the object, lens and screen on an optical bench, remove parallax and find the focal length from u and v readings.",
    tag: "3D"
  },
  {
    slug: "convex-lens-displacement",
    num: 7,
    title: "Convex Lens by the Displacement Method",
    blurb: "Move the lens between two positions that both give a sharp image, then find the focal length from the displacement.",
    tag: "3D"
  },
  {
    slug: "two-convex-lenses",
    num: 8,
    title: "Convex Lens Combined with Another Convex Lens",
    blurb: "Combine two convex lenses (not in contact) on the bench to find the focal length of the second lens.",
    tag: "3D"
  },
  {
    slug: "concave-lens",
    num: 9,
    title: "Concave Lens Combined with a Convex Lens",
    blurb: "Use a convex lens to form a real image, add the concave lens and work out its focal length.",
    tag: "3D"
  },
  {
    slug: "concave-mirror",
    num: 10,
    title: "Focal Length of a Concave Mirror (u–v Method)",
    blurb: "Use two pins on an optical bench, remove parallax and find the focal length of a concave mirror.",
    tag: "3D"
  }
  // , { slug: "...", num: 11, title: "...", blurb: "...", tag: "3D" }
];
