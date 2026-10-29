// A tiny file-based database. Everything is kept in memory and saved to data/db.json after each change.
// To move to a real database later, replace this file; server.js only uses the methods below.

const fs = require("fs");
const path = require("path");

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    this.photoDir = path.join(dir, "photos");
    fs.mkdirSync(this.photoDir, { recursive: true });
    this.issues = [];
    try {
      this.issues = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.reset();
    }
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.issues));
    fs.renameSync(tmp, this.file); // rename is atomic, so a crash can't leave a half-written file
  }

  nextId() {
    return Math.max(0, ...this.issues.map((i) => i.id)) + 1;
  }

  find(id) {
    return this.issues.find((i) => i.id === id);
  }

  add(issue) {
    this.issues.push(issue);
    this.save();
  }

  savePhoto(id, dataUrl) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
    if (!m) return "";
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > 1.5 * 1024 * 1024) return "";
    fs.writeFileSync(path.join(this.photoDir, id + ".jpg"), buf);
    return "/photos/" + id + ".jpg";
  }

  // withSample: true loads the 10 sample reports, false leaves the app empty.
  // By default it follows the SAMPLE_DATA environment variable (SAMPLE_DATA=false means empty).
  reset(withSample = process.env.SAMPLE_DATA !== "false") {
    for (const f of fs.readdirSync(this.photoDir)) fs.unlinkSync(path.join(this.photoDir, f));
    this.issues = withSample ? seed() : [];
    this.save();
  }

  remove(id) {
    const n = this.issues.findIndex((i) => i.id === id);
    if (n < 0) return false;
    this.issues.splice(n, 1);
    fs.rmSync(path.join(this.photoDir, id + ".jpg"), { force: true });
    this.save();
    return true;
  }
}

// Sample reports so the app never starts empty. All made up.
function seed() {
  const day = 864e5;
  const mk = (id, title, description, category, building, room, status, priority, assignee, votes, ageDays, fixedAfter) => {
    const created = Date.now() - ageDays * day;
    const history = [{ ts: created, status: "Reported", note: "Issue reported", by: "Community" }];
    if (status !== "Reported") history.push({ ts: created + day * 0.6, status: "In Progress", note: "Assigned to " + assignee, by: "Facilities" });
    if (status === "Resolved") history.push({ ts: created + day * fixedAfter, status: "Resolved", note: "Fixed and checked", by: "Facilities" });
    return {
      id, title, description, category, building, room, status, priority, assignee,
      photo: "", photoAlt: "", hash: "", createdAt: created,
      voters: Array.from({ length: votes }, (_, i) => `seed-${id}-${i}`),
      history, awaitingConfirm: false, confirmedFixed: false, reopened: 0,
    };
  };
  const list = [
    mk(1, "Hallway light flickering", "The ceiling light outside room 214 flickers constantly and buzzes.", "Electrical", "Sutherland Building", "2nd floor hall", "Reported", "Normal", "Unassigned", 4, 2),
    mk(2, "Leaking tap in restroom", "Sink tap in the men's restroom drips all day and the basin has a puddle.", "Plumbing", "Lares Building", "Ground floor restroom", "In Progress", "Normal", "Crew B (Plumbing)", 6, 3),
    mk(3, "Classroom door jammed", "The door to room 105 sticks and needs a hard shove to open.", "Doors & Windows", "Woodland Building", "Room 105", "Reported", "Normal", "Unassigned", 2, 1),
    mk(4, "Dead outlets at study desks", "Two outlets by the window study desks have no power.", "Electrical", "Library", "Study area", "In Progress", "Normal", "Crew A (Electrical)", 9, 5),
    mk(5, "Icy patch on main steps", "Water freezes on the steps at the main entrance every morning.", "Safety", "Woodland Building", "Main entrance", "Reported", "Urgent", "Unassigned", 11, 1),
    mk(6, "Projector will not turn on", "The projector in room 220 shows no signal and the remote is dead.", "IT", "Rydal Building", "Room 220", "Resolved", "Normal", "IT Help Desk", 3, 9, 2),
    mk(7, "Trash overflowing", "Recycling bins by the vending machines are overflowing.", "Cleaning", "Springfield Building", "Lobby", "Resolved", "Low", "Crew C (General)", 1, 12, 1),
    mk(8, "Wobbly desks in lab", "Several desks in the physics lab wobble and are not safe for experiments.", "Furniture", "Sutherland Building", "Room 118", "Resolved", "Normal", "Crew C (General)", 5, 14, 4),
    mk(9, "Parking lot lamp is out", "The lamp at the north end of the lot is dark, so it is hard to see at night.", "Electrical", "Parking Lot A", "North end", "Reported", "Urgent", "Unassigned", 7, 4),
    mk(10, "Room too cold", "Room 107 stays very cold and the vent blows cold air all class.", "HVAC", "Woodland Building", "Room 107", "In Progress", "Normal", "Crew C (General)", 3, 6),
  ];
  return list;
}

module.exports = { Store };
