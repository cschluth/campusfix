"use strict";
// CampusFix front end. Plain JavaScript, no framework. Reading order:
//   1. helpers   2. talking to the server   3. photo fingerprint   4. screens   5. events

/* ================= 1. helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const sid = (s) => s.replace(/\s/g, "-");
const opts = (arr, sel, blank) => (blank ? `<option value="">${blank}</option>` : "") + arr.map((a) => `<option${a === sel ? " selected" : ""}>${esc(a)}</option>`).join("");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
function toast(m) {
  const t = $("#toast");
  t.textContent = m; t.style.display = "block";
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = "none"), 3200);
}

// Each browser gets a random anonymous id. It is how the server knows who already upvoted. No login, no personal data.
const memoryId = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const visitor = store.get("campusfix.vid") || (() => { store.set("campusfix.vid", memoryId); return memoryId; })();

const state = { cfg: null, issues: [], tab: "browse", filters: { q: "", cat: "", bld: "", st: "" }, draft: {}, showResolved: true, snapshot: "", staff: false, pin: "" };
try { state.pin = sessionStorage.getItem("campusfix.pin") || ""; } catch {}

/* ================= 2. talking to the server ================= */
async function api(path, method = "GET", body) {
  const headers = { "x-visitor": visitor };
  if (body) headers["content-type"] = "application/json";
  if (state.pin) headers["x-staff-pin"] = state.pin;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}
async function refresh(force) {
  const next = await api("/api/issues");
  const snap = JSON.stringify(next);
  if (!force && snap === state.snapshot) return;
  state.snapshot = snap; state.issues = next;
  // Don't redraw while someone is typing a report or has a window open.
  if (force || (state.tab !== "report" && !$("#dlg").open)) render(); else updateBell();
}
const byId = (id) => state.issues.find((i) => i.id === id);

/* ================= 3. photo fingerprint (for duplicate photos) ================= */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => reject(new Error("That file is not a picture"));
    img.src = url;
  });
}
// Shrinks the photo and re-saves it as JPEG. This also removes hidden data such as GPS location.
function toJpeg(img, max = 800) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.75);
}
// "Difference hash": shrink to 9x8 grey pixels, then record whether each pixel is brighter than its right neighbour.
// That gives 64 bits. Photos of the same thing give nearly the same bits, even if the size or brightness differs.
function fingerprint(img) {
  const c = document.createElement("canvas");
  c.width = 9; c.height = 8;
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(img, 0, 0, 9, 8);
  const d = x.getImageData(0, 0, 9, 8).data;
  const grey = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let bits = "";
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) bits += grey((row * 9 + col) * 4) > grey((row * 9 + col + 1) * 4) ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/* ================= 4. screens ================= */
function render() {
  const tabs = [["browse", "Browse"], ["map", "Map"], ["report", "Report an issue"], ["dash", "Dashboard"]];
  if (state.staff) tabs.push(["queue", "Staff queue"]);
  $("#tabs").innerHTML = tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join("");
  $("#staffBtn").textContent = state.staff ? "Staff mode (sign out)" : "Staff sign-in";
  ({ browse: renderBrowse, map: renderMap, report: renderReport, dash: renderDash, queue: renderQueue })[state.tab]();
  updateBell();
}

const badge = (s) => `<span class="badge s-${sid(s)}">${esc(s)}</span>`;
const where = (i) => esc(i.building) + (i.room ? ", " + esc(i.room) : "");

function card(i) {
  const thumb = i.photo ? `<img class="thumb" src="${esc(i.photo)}" alt="${esc(i.photoAlt || "Photo for " + i.title)}">` : `<div class="thumb" aria-hidden="true">🛠</div>`;
  return `<article class="card"><div class="issue">${thumb}<div class="grow">
    <h3>${esc(i.title)}</h3>
    <div class="meta">${esc(i.category)} · ${where(i)} · ${fmt(i.createdAt)}</div>
    <div class="chips">${badge(i.status)}${i.priority === "Urgent" ? '<span class="urgent">Urgent</span>' : ""}
      <span class="meta">${i.votes} ${i.votes === 1 ? "report" : "reports"}</span>
      ${i.canConfirm ? '<span class="chip">Is it fixed? Tell us</span>' : ""}</div>
    <div class="actions"><button class="btn alt sm" data-open="${i.id}">View details</button>
    ${i.status !== "Resolved" && !i.mine ? `<button class="btn sm" data-vote="${i.id}" aria-label="I have this problem too: ${esc(i.title)}">I have this too</button>` : ""}</div>
  </div></div></article>`;
}

function renderBrowse() {
  const f = state.filters, cfg = state.cfg;
  const list = state.issues
    .filter((i) => (!f.cat || i.category === f.cat) && (!f.bld || i.building === f.bld) && (!f.st || i.status === f.st) &&
      (!f.q || (i.title + " " + i.description + " " + i.room + " " + i.building + " " + i.category).toLowerCase().includes(f.q.toLowerCase())))
    .sort((a, b) => (b.priority === "Urgent") - (a.priority === "Urgent") || b.votes - a.votes);
  $("#main").innerHTML = `<h2>All reported issues</h2>
  <div class="card"><label for="q" style="margin-top:0">Search</label><input type="search" id="q" value="${esc(f.q)}" placeholder="e.g. leak, light, door">
  <div class="row"><div><label for="fc">Category</label><select id="fc">${opts(cfg.categories, f.cat, "All categories")}</select></div>
  <div><label for="fb">Location</label><select id="fb">${opts(cfg.buildings.map((b) => b.name), f.bld, "All locations")}</select></div>
  <div><label for="fs">Status</label><select id="fs">${opts(cfg.statuses, f.st, "All statuses")}</select></div></div></div>
  <p class="meta" aria-live="polite">${list.length} issue${list.length === 1 ? "" : "s"} shown</p>${list.map(card).join("") || (state.issues.length ? "<p>No issues match.</p>" : "<p>No reports yet. Be the first: choose Report an issue.</p>")}`;
  $("#q").oninput = (e) => { f.q = e.target.value; const p = e.target.selectionStart; renderBrowse(); const q = $("#q"); q.focus(); q.setSelectionRange(p, p); };
  $("#fc").onchange = (e) => { f.cat = e.target.value; renderBrowse(); };
  $("#fb").onchange = (e) => { f.bld = e.target.value; renderBrowse(); };
  $("#fs").onchange = (e) => { f.st = e.target.value; renderBrowse(); };
}

// ---- Campus map: a simple drawing, not to scale. Every building and pin can also be reached with the keyboard.
function renderMap() {
  const isOpen = (i) => i.status !== "Resolved";
  const shown = state.showResolved ? state.issues : state.issues.filter(isOpen);
  const letter = { Reported: "R", "In Progress": "P", Resolved: "✓" };
  let rects = "", pins = "";
  const rows = [];
  for (const b of state.cfg.buildings) {
    const here = shown.filter((i) => i.building === b.name).sort((x, y) => isOpen(y) - isOpen(x)); // open pins first, so resolved ones are dropped first when crowded
    const nOpen = here.filter(isOpen).length, nRes = here.length - nOpen;
    const heat = Math.min(3, nOpen === 0 ? 0 : nOpen <= 1 ? 1 : nOpen <= 3 ? 2 : 3); // shading follows open issues only
    rows.push([b.name, nOpen, nRes]);
    rects += `<g class="bld" role="button" tabindex="0" data-bld="${esc(b.name)}" aria-label="${esc(b.name)}: ${nOpen} open, ${nRes} resolved. Show them in the list">
      <rect class="h${heat}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8"/>
      <text x="${b.x + 10}" y="${b.y + 20}">${esc(b.name)}</text><text class="cnt" x="${b.x + 10}" y="${b.y + 36}">${nOpen} open${nRes ? " \u00b7 " + nRes + " resolved" : ""}</text></g>`;
    const cols = Math.floor((b.w - 20) / 22), cap = cols * 2;
    const draw = here.length > cap ? here.slice(0, cap - 1) : here;
    draw.forEach((i, n) => {
      const cx = b.x + 18 + (n % cols) * 22, cy = b.y + 56 + Math.floor(n / cols) * 20;
      pins += `<g class="pin ${sid(i.status)}" role="button" tabindex="0" data-open="${i.id}" aria-label="${esc(i.title)}, ${esc(i.status)}">
        <circle cx="${cx}" cy="${cy}" r="9"/><text x="${cx}" y="${cy + 3.5}">${letter[i.status]}</text></g>`;
    });
    if (here.length > cap) pins += `<text x="${b.x + 18 + (cap - 1) % cols * 22 - 8}" y="${b.y + 76}" font-size="12" font-weight="700" fill="#14294f">+${here.length - cap + 1}</text>`;
  }
  $("#main").innerHTML = `<h2>Campus map</h2>
  <p class="hint">A simple sketch, not to scale. Darker buildings have more open issues. Each pin is one report: it changes from R to P to ✓ as it moves along. Select a pin to see the report, or a building to list its issues.</p>
  <div class="legend"><span><i class="sw R">R</i>Reported</span><span><i class="sw P">P</i>In progress</span><span><i class="sw C">✓</i>Resolved</span>
    <label style="margin:0;font-weight:400"><input type="checkbox" id="showRes" ${state.showResolved ? "checked" : ""}> Show resolved</label></div>
  <svg class="map" viewBox="0 0 600 400" role="group" aria-label="Campus map with reported issues">${rects}${pins}</svg>
  <div class="card"><h3>Issues by building</h3><table><thead><tr><th>Building</th><th>Open</th><th>Resolved</th></tr></thead><tbody>
  ${rows.sort((a, b) => b[1] - a[1] || b[2] - a[2]).map(([n, o, r]) => `<tr><td><button class="pill" data-bld="${esc(n)}">${esc(n)}</button></td><td>${o}</td><td>${r}</td></tr>`).join("")}</tbody></table></div>`;
  $("#showRes").onchange = (e) => { state.showResolved = e.target.checked; renderMap(); };
}

// ---- Report form: hints while typing, then the duplicate check before anything is saved.
function renderReport() {
  const d = state.draft, cfg = state.cfg;
  $("#main").innerHTML = `<h2>Report an issue</h2>
  ${d.fromQr ? '<p class="card warn">Location filled in from the sign you scanned. Check it looks right.</p>' : ""}
  <form id="rf" class="card" novalidate>
   <label for="t" style="margin-top:0">Title *</label><input type="text" id="t" value="${esc(d.title)}" maxlength="80" required>
   <label for="d">Description *</label><textarea id="d" maxlength="1000" required>${esc(d.description)}</textarea>
   <div id="safety" aria-live="polite"></div>
   <div class="row">
    <div><label for="c">Category *</label><select id="c">${opts(cfg.categories, d.category, "Choose…")}</select><div id="sug" class="hint" aria-live="polite"></div></div>
    <div><label for="b">Building *</label><select id="b">${opts(cfg.buildings.map((b) => b.name), d.building, "Choose…")}</select></div>
    <div><label for="r">Room / spot</label><input type="text" id="r" value="${esc(d.room)}" maxlength="60" placeholder="e.g. Room 214"></div>
   </div>
   <label for="p">Photo (optional)</label><input type="file" id="p" accept="image/*">
   <div class="hint">Photograph the problem only. Please keep people out of the picture.</div>
   <div id="pv">${d.photo ? `<img class="photo" src="${d.photo}" alt="Preview of your photo">` : ""}</div>
   <label for="pa">Describe the photo (for screen readers)</label><input type="text" id="pa" value="${esc(d.photoAlt)}" maxlength="200" placeholder="e.g. Water dripping from a tap into a sink">
   <p id="err" role="alert" style="color:var(--danger);font-weight:600"></p>
   <button class="btn" type="submit" id="go">Check for similar reports</button>
  </form><div id="dups"></div>`;

  const sync = () => { d.title = $("#t").value; d.description = $("#d").value; d.category = $("#c").value; d.building = $("#b").value; d.room = $("#r").value; d.photoAlt = $("#pa").value; };
  ["t", "d", "c", "b", "r", "pa"].forEach((id) => $("#" + id).addEventListener("input", sync));

  const hints = async () => {
    sync();
    if (d.title.length + d.description.length < 8) return;
    try {
      const a = await api("/api/analyze", "POST", payload());
      $("#safety").innerHTML = a.safety.length
        ? `<div class="card alert" role="alert"><strong>This may be a safety hazard.</strong> It will be flagged urgent. If anyone is in danger right now, contact ${esc(state.cfg.safetyContact)}.</div>` : "";
      $("#sug").innerHTML = a.suggestion && !d.category
        ? `Suggested: <button type="button" class="pill" id="useSug">${esc(a.suggestion.category)}</button> (matched: ${a.suggestion.matched.map(esc).join(", ")})` : "";
      const u = $("#useSug");
      if (u) u.onclick = () => { $("#c").value = a.suggestion.category; d.category = a.suggestion.category; $("#sug").textContent = ""; };
    } catch {}
  };
  $("#d").addEventListener("blur", hints);
  $("#t").addEventListener("blur", hints);

  $("#p").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const img = await loadImage(f);
      d.photo = toJpeg(img); d.hash = fingerprint(img);
      $("#pv").innerHTML = `<img class="photo" src="${d.photo}" alt="Preview of your photo">`;
    } catch (err) { $("#err").textContent = err.message; }
  };

  $("#rf").onsubmit = async (e) => {
    e.preventDefault(); sync();
    const missing = [!d.title.trim() && "title", !d.description.trim() && "description", !d.category && "category", !d.building && "building"].filter(Boolean);
    if (missing.length) { $("#err").textContent = "Please fill in: " + missing.join(", "); return; }
    $("#err").textContent = "";
    const go = $("#go");
    go.disabled = true;
    try {
      const a = await api("/api/analyze", "POST", payload());
      if (!a.similar.length) await submitNew(); else showDups(a.similar);
    } catch (err) { $("#err").textContent = err.message; }
    go.disabled = false; // go may have left the page after a successful submit; that is fine
  };
}
const payload = () => { const d = state.draft; return { title: d.title, description: d.description, category: d.category, building: d.building, room: d.room, hash: d.hash || "", photo: d.photo || "", photoAlt: d.photoAlt || "" }; };

function showDups(similar) {
  $("#dups").innerHTML = `<div class="card warn" role="region" aria-label="Similar reports"><h3>Is it one of these?</h3>
  <p>Someone may have reported this already. Adding your report to an existing one tells facilities it affects more people, and you get its updates.</p>
  ${similar.map((m) => `<div class="card"><div class="issue">${m.issue.photo ? `<img class="thumb" src="${esc(m.issue.photo)}" alt="Photo attached to this report">` : ""}<div class="grow">
    <strong>${esc(m.issue.title)}</strong> ${badge(m.issue.status)}
    <div class="meta">${esc(m.issue.building)}${m.issue.room ? ", " + esc(m.issue.room) : ""} · ${m.issue.votes} ${m.issue.votes === 1 ? "report" : "reports"}</div>
    <p>${esc(m.issue.description)}</p>
    <div class="chips"><strong>${esc(m.strength)}</strong>${m.reasons.map((r) => `<span class="chip">${esc(r)}</span>`).join("")}</div>
    ${byId(m.issue.id)?.mine ? '<p class="hint">You already reported or added to this one, so it already counts you.</p><button class="btn sm" data-dupvote="' + m.issue.id + '">OK, that is the one I reported</button>'
      : `<button class="btn sm" data-dupvote="${m.issue.id}">Yes, same problem: add my report</button>`}</div></div></div>`).join("")}
  <button class="btn alt" id="newAnyway">No, mine is different: submit as new</button></div>`;
  $("#dups").scrollIntoView({ behavior: "smooth" });
  $("#newAnyway").onclick = () => submitNew().catch((e) => toast(e.message));
}
async function submitNew() {
  await api("/api/issues", "POST", payload());
  state.draft = {}; state.tab = "browse"; state.filters = { q: "", cat: "", bld: "", st: "" };
  await refresh(true);
  toast("Report submitted. You'll see updates under Updates.");
}

// ---- Dashboard
function resolvedAt(i) { const h = i.history.find((x) => x.status === "Resolved"); return h ? h.ts : null; }
function renderDash() {
  const all = state.issues, open = all.filter((i) => i.status !== "Resolved"), res = all.filter((i) => i.status === "Resolved");
  const times = res.map((i) => resolvedAt(i) - i.createdAt).filter((t) => t > 0);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length / 864e5 : 0;
  const confirmed = res.filter((i) => i.confirmedFixed).length, reopened = all.reduce((s, i) => s + i.reopened, 0);
  const tally = (key, arr) => { const m = {}; arr.forEach((i) => (m[i[key]] = (m[i[key]] || 0) + i.votes)); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bars = (rows) => { const mx = Math.max(1, ...rows.map((r) => r[1])); return rows.map(([l, n]) => `<div class="bar"><span class="l">${esc(l)}</span><span class="f" style="width:${(n / mx) * 55}%"></span><span class="n">${n}</span></div>`).join("") || "<p class='meta'>Nothing yet.</p>"; };
  const recent = res.slice().sort((a, b) => resolvedAt(b) - resolvedAt(a)).slice(0, 5);
  $("#main").innerHTML = `<h2>Dashboard</h2>
  <div class="stats"><div class="stat"><b>${all.length}</b>Total issues</div><div class="stat"><b>${open.length}</b>Open</div><div class="stat"><b>${res.length}</b>Resolved</div>
  <div class="stat"><b>${avg.toFixed(1)} days</b>Average time to resolve</div><div class="stat"><b>${confirmed}</b>Fixes confirmed by reporters</div><div class="stat"><b>${reopened}</b>Reopened as not fixed</div></div>
  <div class="card"><h3>Open issues by building (counting every report)</h3>${bars(tally("building", open))}</div>
  <div class="card"><h3>Open issues by category</h3>${bars(tally("category", open))}</div>
  <div class="card"><h3>Recently fixed</h3>${recent.map((i) => `<p style="margin:6px 0"><strong>${esc(i.title)}</strong> <span class="meta">${where(i)} · fixed ${fmt(resolvedAt(i))}${i.confirmedFixed ? " · confirmed by a reporter" : ""}</span></p>`).join("") || "<p class='meta'>Nothing fixed yet.</p>"}</div>
  <p class="hint">Every "I have this too" counts as a report without creating a second ticket, so the counts show how many people are affected.</p>`;
}

// ---- Staff queue: open issues ranked by a score that shows its working
function renderQueue() {
  const q = state.issues.filter((i) => i.status !== "Resolved").sort((a, b) => b.score - a.score);
  $("#main").innerHTML = `<h2>Staff queue</h2>
  <p class="hint">Ranked by priority score: urgent and safety issues, number of reports, and age. Overdue means it has been open longer than its target time.</p>
  ${q.map((i, n) => `<article class="card"><div class="q"><div class="rank" aria-hidden="true">${n + 1}</div><div class="grow">
    <h3>${esc(i.title)}</h3><div class="meta">${esc(i.category)} · ${where(i)} · Assigned: ${esc(i.assignee)}</div>
    <div class="chips">${badge(i.status)}${i.priority === "Urgent" ? '<span class="urgent">Urgent</span>' : ""}${i.overdue ? '<span class="badge overdue">Overdue</span>' : ""}
      <strong>Score ${i.score}</strong>${i.scoreParts.map((p) => `<span class="chip">${esc(p.label)} +${p.points}</span>`).join("")}</div>
    <div class="actions"><button class="btn alt sm" data-open="${i.id}">Open</button>
    ${i.status === "Reported" ? `<button class="btn sm" data-quick="${i.id}:start">Start work</button>` : ""}
    <button class="btn sm" data-quick="${i.id}:resolve">Mark resolved</button></div></div></div></article>`).join("") || "<p>Nothing open. Nice work.</p>"}
  <section class="card"><h3>Staff tools</h3>
    <p class="hint">Handy for demos and for housekeeping. Clearing and reloading ask you to confirm first.</p>
    <div class="actions"><button class="btn alt" data-tool="csv">Export all reports (CSV)</button>
    <button class="btn alt" data-tool="sample">Load sample reports</button>
    <button class="btn danger" data-tool="clear">Clear all reports</button></div></section>`;
}

// Download every report as a spreadsheet file. Cells that start with = + - @ get a leading ' so spreadsheets never run them as formulas.
function exportCsv() {
  const cols = ["id", "title", "description", "category", "building", "room", "status", "priority", "assignee", "reports", "created", "resolved"];
  const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = state.issues.map((i) => [i.id, i.title, i.description, i.category, i.building, i.room, i.status, i.priority, i.assignee, i.votes,
    new Date(i.createdAt).toISOString(), resolvedAt(i) ? new Date(resolvedAt(i)).toISOString() : ""]);
  const csv = [cols, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "campusfix-reports.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A confirmation step built into the page (browsers can block the built-in confirm box).
function confirmDialog(message, label, action) {
  const dlg = $("#dlg");
  if (dlg.open) dlg.close();
  dlg.innerHTML = `<h2 id="dlgT">Are you sure?</h2><p>${esc(message)}</p>
  <div class="actions"><button class="btn danger" data-doit="${esc(JSON.stringify(action))}">${esc(label)}</button><button class="btn alt" data-close="1">Cancel</button></div>`;
  dlg.showModal();
}

// ---- Detail window
function openDetail(id) {
  const i = byId(id), dlg = $("#dlg");
  if (!i) return;
  const suggested = i.assignee !== "Unassigned" ? i.assignee : state.cfg.crewByCategory[i.category] || state.cfg.defaultCrew;
  dlg.innerHTML = `<h2 id="dlgT">${esc(i.title)}</h2>
  <div class="chips">${badge(i.status)}<span class="meta">${esc(i.category)} · ${where(i)}</span></div>
  ${i.photo ? `<img class="photo" src="${esc(i.photo)}" alt="${esc(i.photoAlt || "Photo for " + i.title)}">` : ""}
  <p>${esc(i.description)}</p>
  <p class="meta">${i.votes} ${i.votes === 1 ? "report" : "reports"} · Priority: ${esc(i.priority)} · Assigned: ${esc(i.assignee)}</p>
  ${i.canConfirm ? `<div class="card warn"><strong>Facilities says this is fixed. Is it?</strong>
    <div class="actions" style="margin-top:8px"><button class="btn" data-confirm="${i.id}:yes">Yes, it's fixed</button><button class="btn alt" data-confirm="${i.id}:no">No, still broken</button></div></div>` : ""}
  <h3>History</h3><ol class="tl">${i.history.map((h) => `<li><strong>${esc(h.status)}</strong> · ${fmt(h.ts)} · ${esc(h.by)}<br>${esc(h.note)}</li>`).join("")}</ol>
  ${state.staff ? `<form id="sf" class="card"><h3>Facilities actions</h3>
    <p class="meta">Score ${i.score}: ${i.scoreParts.map((p) => esc(p.label) + " +" + p.points).join(", ") || "none"}</p>
    <div class="row"><div><label for="ss">Status</label><select id="ss">${opts(state.cfg.statuses, i.status)}</select></div>
    <div><label for="sp">Priority</label><select id="sp">${opts(state.cfg.priorities, i.priority)}</select></div>
    <div><label for="sa">Assign to</label><select id="sa">${opts(state.cfg.crews, suggested)}</select></div></div>
    <label for="sn">Note shown to reporters</label><input type="text" id="sn" maxlength="200" placeholder="e.g. Part ordered, fix planned for Friday">
    <div class="actions" style="margin-top:12px"><button class="btn" type="submit">Save update</button>
    <button class="btn danger" type="button" data-delete="${i.id}">Delete report</button></div></form>` : ""}
  <div class="actions" style="margin-top:8px">
  ${!state.staff && i.status !== "Resolved" && !i.mine ? `<button class="btn" data-vote="${i.id}" data-closedlg="1">I have this problem too</button>` : ""}
  <button class="btn alt" data-close="1">Close</button></div>`;
  dlg.showModal();
  const f = $("#sf");
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/issues/${id}/staff`, "POST", { status: $("#ss").value, priority: $("#sp").value, assignee: $("#sa").value, note: $("#sn").value });
      dlg.close(); await refresh(true); toast("Update saved");
    } catch (err) { toast(err.message); }
  };
}

// ---- Updates (per visitor): staff changes to anything you reported or upvoted, plus "is it fixed?" questions
function updates() {
  const seen = +store.get("campusfix.seen") || 0, out = [];
  for (const i of state.issues) {
    if (!i.mine) continue;
    i.history.forEach((h, n) => { if (n > 0 && h.by === "Facilities" && h.ts > seen) out.push({ i, text: `${h.status}. ${h.note}`, ts: h.ts }); });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
function updateBell() {
  const n = updates().length + state.issues.filter((i) => i.canConfirm).length;
  $("#bellN").textContent = n ? `(${n})` : "";
}
function openBell() {
  const ups = updates(), ask = state.issues.filter((i) => i.canConfirm), dlg = $("#dlg");
  dlg.innerHTML = `<h2 id="dlgT">Updates on your reports</h2>
  ${ask.map((i) => `<div class="card warn"><strong>${esc(i.title)}</strong> was marked fixed. <button class="btn sm" data-open="${i.id}">Is it fixed?</button></div>`).join("")}
  ${ups.length ? `<ul>${ups.map((u) => `<li><strong>${esc(u.i.title)}</strong>: ${esc(u.text)} <span class="meta">(${fmt(u.ts)})</span></li>`).join("")}</ul>` : ask.length ? "" : "<p>No new updates.</p>"}
  <p class="hint">You only see updates for issues you reported or added your report to, from this device.</p>
  <div class="actions"><button class="btn" id="mark">Mark all as read</button><button class="btn alt" data-close="1">Close</button></div>`;
  dlg.showModal();
  $("#mark").onclick = () => { store.set("campusfix.seen", Date.now()); dlg.close(); updateBell(); };
}

// ---- Staff sign-in
function staffDialog() {
  const dlg = $("#dlg");
  if (state.staff) { state.staff = false; state.pin = ""; try { sessionStorage.removeItem("campusfix.pin"); } catch {} if (state.tab === "queue") state.tab = "browse"; return refresh(true); }
  dlg.innerHTML = `<h2 id="dlgT">Staff sign-in</h2><form id="pf"><label for="pin">Staff PIN</label><input type="password" id="pin" autocomplete="off">
  ${state.cfg.demoPin ? `<p class="hint">Demo PIN on this computer: ${esc(state.cfg.demoPin)}</p>` : ""}
  <p id="perr" role="alert" style="color:var(--danger);font-weight:600"></p>
  <div class="actions"><button class="btn" type="submit">Sign in</button><button class="btn alt" type="button" data-close="1">Cancel</button></div></form>`;
  dlg.showModal();
  $("#pf").onsubmit = async (e) => {
    e.preventDefault();
    state.pin = $("#pin").value;
    try {
      await api("/api/staff/check");
      state.staff = true; try { sessionStorage.setItem("campusfix.pin", state.pin); } catch {}
      dlg.close(); state.tab = "queue"; await refresh(true); toast("Staff mode on");
    } catch { state.pin = ""; $("#perr").textContent = "That PIN is not correct."; }
  };
}

/* ================= 5. events ================= */
// Adds the visitor's report to an existing issue. Each browser counts once, so a repeat tap changes nothing and says so.
async function addReport(id) {
  const already = byId(id)?.mine;
  const r = await api(`/api/issues/${id}/upvote`, "POST");
  return already ? "You already reported this one, so it already counts you." : `Added. This issue now has ${r.votes} reports, and you'll get its updates.`;
}
async function act(fn) { try { await fn(); } catch (e) { toast(e.message); } }
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab],[data-open],[data-vote],[data-dupvote],[data-bld],[data-quick],[data-confirm],[data-close],[data-tool],[data-delete],[data-doit]");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { state.tab = d.tab; render(); $("#main").focus(); }
  else if (d.close) $("#dlg").close();
  else if (d.tool === "csv") exportCsv();
  else if (d.tool === "clear") confirmDialog("This removes every report and photo. It cannot be undone.", "Yes, clear everything", { mode: "empty" });
  else if (d.tool === "sample") confirmDialog("This replaces all current reports with the 10 sample reports.", "Yes, load the samples", { mode: "sample" });
  else if (d.delete) confirmDialog("This permanently deletes the report and its photo.", "Yes, delete it", { del: +d.delete });
  else if (d.doit) act(async () => {
    const a = JSON.parse(d.doit);
    if (a.del) await api(`/api/issues/${a.del}/delete`, "POST"); else await api("/api/reset", "POST", { mode: a.mode });
    $("#dlg").close(); await refresh(true); toast("Done");
  });
  else if (d.open) { if ($("#dlg").open) $("#dlg").close(); openDetail(+d.open); }
  else if (d.bld) { state.filters = { q: "", cat: "", bld: d.bld, st: "" }; state.tab = "browse"; render(); $("#main").focus(); }
  else if (d.vote) act(async () => { const r = await addReport(+d.vote); if (d.closedlg) $("#dlg").close(); await refresh(true); toast(r); });
  else if (d.dupvote) act(async () => { const r = await addReport(+d.dupvote); state.draft = {}; state.tab = "browse"; await refresh(true); toast(r); });
  else if (d.quick) act(async () => {
    const [id, what] = d.quick.split(":"), i = byId(+id);
    const body = what === "start" ? { status: "In Progress", assignee: state.cfg.crewByCategory[i.category] || state.cfg.defaultCrew } : { status: "Resolved" };
    await api(`/api/issues/${id}/staff`, "POST", body); await refresh(true); toast("Updated");
  });
  else if (d.confirm) act(async () => {
    const [id, ans] = d.confirm.split(":");
    await api(`/api/issues/${id}/confirm`, "POST", { fixed: ans === "yes" });
    $("#dlg").close(); await refresh(true); toast(ans === "yes" ? "Thanks for confirming." : "Thanks. We've reopened it.");
  });
});
// Make non-button elements (map pins and buildings) work with Enter and Space.
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if ((e.key === "Enter" || e.key === " ") && t.matches && t.matches('[role="button"][tabindex]') && t.tagName.toLowerCase() === "g") { e.preventDefault(); t.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
$("#bell").onclick = openBell;
$("#staffBtn").onclick = () => act(staffDialog);

(async function start() {
  try {
    state.cfg = await api("/api/config");
    $("#appName").textContent = state.cfg.appName; $("#campusName").textContent = state.cfg.campusName; $("#footerNote").textContent = state.cfg.footerNote; document.title = state.cfg.appName;
    if (state.pin) { try { await api("/api/staff/check"); state.staff = true; } catch { state.pin = ""; } }
    // A QR code poster opens the app like /?b=Library&r=Room%20101 and pre-fills the location.
    const q = new URLSearchParams(location.search), b = q.get("b");
    if (b && state.cfg.buildings.some((x) => x.name === b)) { state.draft = { building: b, room: (q.get("r") || "").slice(0, 60), fromQr: true }; state.tab = "report"; }
    await refresh(true);
    setInterval(() => refresh(false).catch(() => {}), 8000); // pick up other people's changes
  } catch (e) {
    $("#main").innerHTML = `<p class="card alert" role="alert">Could not load. ${esc(e.message)}</p>`;
  }
})();
