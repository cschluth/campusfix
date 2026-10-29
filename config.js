// CampusFix settings. To make this app your own, edit this file only:
// the name, the buildings, the categories and the rules all live here.

module.exports = {
  appName: "CampusFix",
  campusName: "Penn State Abington (sample data)",
  safetyContact: "Campus Safety: (555) 010-0100 (sample number)", // replace with the real number for a real launch
  footerNote: "Sample data only. Please don't include names, ID numbers or photos of people.",

  // Category -> keywords. Used to suggest a category from what the user types.
  categories: {
    Electrical: ["light", "lamp", "bulb", "outlet", "socket", "power", "electric", "flicker", "switch"],
    Plumbing: ["leak", "faucet", "toilet", "pipe", "drain", "water", "flush", "flood"],
    Cleaning: ["spill", "trash", "dirty", "smell", "clean", "mess", "bin"],
    Furniture: ["desk", "chair", "table", "shelf", "whiteboard", "cabinet", "wobbly"],
    Safety: ["ice", "slip", "fire", "alarm", "hazard", "exposed", "wire", "unsafe", "smoke", "glass"],
    IT: ["projector", "internet", "computer", "printer", "screen", "monitor"],
    "Doors & Windows": ["door", "window", "lock", "stuck", "handle", "hinge", "latch"],
    HVAC: ["heat", "heating", "cold", "hot", "vent", "ac", "temperature"],
  },

  // Buildings, with a rectangle each on the schematic map (600 x 400 canvas).
  buildings: [
    { name: "Lares Building", x: 40, y: 40, w: 150, h: 85 },
    { name: "Sutherland Building", x: 225, y: 40, w: 150, h: 85 },
    { name: "Woodland Building", x: 410, y: 40, w: 150, h: 85 },
    { name: "Rydal Building", x: 40, y: 160, w: 150, h: 85 },
    { name: "Springfield Building", x: 225, y: 160, w: 150, h: 85 },
    { name: "Library", x: 410, y: 160, w: 150, h: 85 },
    { name: "Parking Lot A", x: 225, y: 280, w: 150, h: 85 },
  ],

  // Who fixes what. Used to suggest an assignee for staff.
  crews: ["Unassigned", "Crew A (Electrical)", "Crew B (Plumbing)", "Crew C (General)", "IT Help Desk"],
  crewByCategory: {
    Electrical: "Crew A (Electrical)",
    Plumbing: "Crew B (Plumbing)",
    IT: "IT Help Desk",
  },
  defaultCrew: "Crew C (General)",

  // Days before an open issue counts as overdue, by priority.
  slaDays: { Urgent: 1, Normal: 5, Low: 10 },

  // Words that make a report look like a safety hazard.
  safetyWords: ["exposed wire", "sparks", "smoke", "fire", "gas", "ice", "icy", "slip", "broken glass", "flood", "unsafe", "collapse"],

  duplicate: {
    threshold: 0.35, // minimum score to be shown as "similar"
    photoMaxDistance: 10, // max differing bits (out of 64) for photos to count as alike
  },
};
