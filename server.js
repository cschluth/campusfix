// CampusFix server. No npm packages needed: just Node 18 or newer.
//   node server.js        (or: npm start)
// Settings via environment variables: PORT, STAFF_PIN, DATA_DIR.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cfg = require("./config");
const { Store } = require("./lib/store");
const sim = require("./lib/similarity");

const PORT = process.env.PORT || 3000;
const DEFAULT_PIN = "1234";
const STAFF_PIN = process.env.STAFF_PIN || DEFAULT_PIN;
const STATUSES = ["Reported", "In Progress", "Resolved"];
const PRIORITIES = ["Low", "Normal", "Urgent"];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };

function createServer(dataDir = process.env.DATA_DIR || path.join(__dirname, "data")) {
  const store = new Store(dataDir);
  const hits = new Map(); // simple rate limit: writes per minute per IP

  // ---------- helpers ----------
  const send = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
  const isStaff = (req) => {
    const a = Buffer.from(String(req.headers["x-staff-pin"] || ""));
    const b = Buffer.from(STAFF_PIN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const visitorOf = (req) => {
    const v = String(req.headers["x-visitor"] || "");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(v)) throw fail(400, "Missing visitor id");
    return v;
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0, chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 3e6) { reject(fail(413, "Request too large")); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
        catch { reject(fail(400, "Invalid JSON")); }
      });
    });
  const limited = (req) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim();
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 60;
  };

  // What the browser is allowed to see about an issue. Voter ids stay on the server.
  const publicIssue = (i, visitor) => {
    const p = sim.priority(i, cfg);
    const mine = i.voters.includes(visitor);
    return {
      id: i.id, title: i.title, description: i.description, category: i.category, building: i.building, room: i.room,
      status: i.status, priority: i.priority, assignee: i.assignee, photo: i.photo, photoAlt: i.photoAlt,
      createdAt: i.createdAt, votes: i.voters.length, mine, history: i.history,
      awaitingConfirm: i.awaitingConfirm, canConfirm: mine && i.awaitingConfirm, confirmedFixed: i.confirmedFixed, reopened: i.reopened,
      score: p.score, scoreParts: p.parts, overdue: p.overdue,
    };
  };
  const brief = (i) => ({ id: i.id, title: i.title, description: i.description, status: i.status, building: i.building, room: i.room, votes: i.voters.length, photo: i.photo });

  // ---------- routes ----------
  const routes = {
    "GET /api/config": (req) => ({
      appName: cfg.appName, campusName: cfg.campusName, safetyContact: cfg.safetyContact, footerNote: cfg.footerNote,
      categories: Object.keys(cfg.categories), buildings: cfg.buildings, crews: cfg.crews,
      crewByCategory: cfg.crewByCategory, defaultCrew: cfg.defaultCrew, statuses: STATUSES, priorities: PRIORITIES,
      // Only hint the demo PIN when the page is opened on this computer or its local network, never on a public site.
      demoPin: STAFF_PIN === DEFAULT_PIN && /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(req.headers.host || "") ? DEFAULT_PIN : null,
    }),

    "GET /api/issues": (req) => {
      const v = visitorOf(req);
      return store.issues.map((i) => publicIssue(i, v));
    },

    "GET /api/staff/check": (req) => {
      if (!isStaff(req)) throw fail(401, "Wrong PIN");
      return { ok: true };
    },

    // Used twice by the report form: category/safety hints while typing, and the duplicate check before submitting.
    "POST /api/analyze": async (req) => {
      const b = await readBody(req);
      const draft = { title: clean(b.title, 80), description: clean(b.description, 1000), category: clean(b.category, 40), building: clean(b.building, 60), room: clean(b.room, 60), hash: clean(b.hash, 16) };
      const text = draft.title + " " + draft.description;
      return {
        similar: sim.findSimilar(draft, store.issues, cfg.duplicate).map((m) => ({ issue: brief(m.issue), strength: m.strength, reasons: m.reasons })),
        suggestion: sim.suggestCategory(text, cfg.categories),
        safety: sim.findSafety(text, cfg.safetyWords),
      };
    },

    "POST /api/issues": async (req) => {
      const v = visitorOf(req);
      const b = await readBody(req);
      const d = { title: clean(b.title, 80), description: clean(b.description, 1000), category: clean(b.category, 40), building: clean(b.building, 60), room: clean(b.room, 60) };
      if (!d.title || !d.description) throw fail(400, "Title and description are required");
      if (!cfg.categories[d.category]) throw fail(400, "Unknown category");
      if (!cfg.buildings.some((x) => x.name === d.building)) throw fail(400, "Unknown location");
      const id = store.nextId();
      const urgent = sim.findSafety(d.title + " " + d.description, cfg.safetyWords).length > 0;
      const hash = /^[0-9a-f]{16}$/.test(b.hash || "") ? b.hash : "";
      const issue = {
        id, ...d, status: "Reported", priority: urgent ? "Urgent" : "Normal", assignee: "Unassigned",
        photo: store.savePhoto(id, b.photo), photoAlt: clean(b.photoAlt, 200), hash,
        createdAt: Date.now(), voters: [v],
        history: [{ ts: Date.now(), status: "Reported", note: urgent ? "Issue reported. Flagged urgent because it looks like a safety hazard." : "Issue reported", by: "Community" }],
        awaitingConfirm: false, confirmedFixed: false, reopened: 0,
      };
      if (!issue.photo) issue.hash = "";
      store.add(issue);
      return publicIssue(issue, v);
    },

    "POST /api/issues/:id/upvote": (req, m) => {
      const v = visitorOf(req);
      const i = store.find(+m.id);
      if (!i) throw fail(404, "Not found");
      if (i.status === "Resolved") throw fail(400, "This issue is already resolved");
      if (!i.voters.includes(v)) {
        i.voters.push(v);
        i.history.push({ ts: Date.now(), status: i.status, note: `Another person reported this (${i.voters.length} reports now)`, by: "Community" });
        store.save();
      }
      return publicIssue(i, v);
    },

    // Staff only: change status, priority, assignee, and add a note.
    "POST /api/issues/:id/staff": async (req, m) => {
      if (!isStaff(req)) throw fail(401, "Staff PIN required");
      const b = await readBody(req);
      const i = store.find(+m.id);
      if (!i) throw fail(404, "Not found");
      const notes = [];
      if (b.priority && b.priority !== i.priority && PRIORITIES.includes(b.priority)) { i.priority = b.priority; notes.push("Priority set to " + b.priority); }
      if (b.assignee && b.assignee !== i.assignee && cfg.crews.includes(b.assignee)) { i.assignee = b.assignee; notes.push("Assigned to " + b.assignee); }
      const statusChanged = b.status && b.status !== i.status && STATUSES.includes(b.status);
      if (statusChanged) {
        i.status = b.status;
        i.awaitingConfirm = b.status === "Resolved";
        i.confirmedFixed = false;
      }
      const note = clean(b.note, 200);
      if (note) notes.push(note);
      if (notes.length || statusChanged) {
        i.history.push({ ts: Date.now(), status: i.status, note: notes.join(". ") || "Status updated", by: "Facilities" });
        store.save();
      }
      return publicIssue(i, "staff");
    },

    // A reporter or upvoter says whether the fix really worked. "Not fixed" reopens the issue.
    "POST /api/issues/:id/confirm": async (req, m) => {
      const v = visitorOf(req);
      const b = await readBody(req);
      const i = store.find(+m.id);
      if (!i) throw fail(404, "Not found");
      if (!i.voters.includes(v) || !i.awaitingConfirm) throw fail(400, "Nothing to confirm");
      i.awaitingConfirm = false;
      if (b.fixed) {
        i.confirmedFixed = true;
        i.history.push({ ts: Date.now(), status: "Resolved", note: "A reporter confirmed the fix", by: "Reporter" });
      } else {
        i.status = "In Progress";
        i.reopened += 1;
        i.history.push({ ts: Date.now(), status: "In Progress", note: "Reopened: a reporter says it is still not fixed", by: "Reporter" });
      }
      store.save();
      return publicIssue(i, v);
    },

    // Staff only: remove one report (for example a test or inappropriate one).
    "POST /api/issues/:id/delete": (req, m) => {
      if (!isStaff(req)) throw fail(401, "Staff PIN required");
      if (!store.remove(+m.id)) throw fail(404, "Not found");
      return { ok: true };
    },

    // Staff only: wipe everything. mode "empty" leaves no reports, "sample" loads the sample reports.
    "POST /api/reset": async (req) => {
      if (!isStaff(req)) throw fail(401, "Staff PIN required");
      const b = await readBody(req);
      store.reset(b.mode === "sample" ? true : b.mode === "empty" ? false : undefined);
      return { ok: true };
    },
  };

  function match(method, pathname) {
    for (const key of Object.keys(routes)) {
      const [m, pattern] = key.split(" ");
      if (m !== method) continue;
      const names = [];
      const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
      const hit = re.exec(pathname);
      if (hit) return { handler: routes[key], params: Object.fromEntries(names.map((n, i) => [n, hit[i + 1]])) };
    }
    return null;
  }

  function serveFile(res, base, rel) {
    const file = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    try {
      if (pathname.startsWith("/api/")) {
        if (req.method === "POST" && limited(req)) throw fail(429, "Too many requests. Please wait a moment.");
        const r = match(req.method, pathname);
        if (!r) throw fail(404, "Not found");
        return send(res, 200, await r.handler(req, r.params));
      }
      if (pathname.startsWith("/photos/")) return serveFile(res, store.photoDir, pathname.slice(8));
      return serveFile(res, path.join(__dirname, "public"), pathname === "/" ? "index.html" : pathname.slice(1));
    } catch (e) {
      send(res, e.code || 500, { error: e.code ? e.message : "Server error" });
      if (!e.code) console.error(e);
    }
  });
  server.store = store;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`CampusFix running:  http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list) if (n.family === "IPv4" && !n.internal) console.log(`On your Wi-Fi:      http://${n.address}:${PORT}`);
    if (STAFF_PIN === DEFAULT_PIN) console.log("Staff PIN is the demo default (1234). Set STAFF_PIN before sharing publicly.");
  });
}
