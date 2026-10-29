// Run with: npm test   (uses Node's built-in test runner, nothing to install)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = require("../config");
const sim = require("../lib/similarity");
const { createServer } = require("../server");

test("text similarity understands synonyms", () => {
  const same = sim.textSimilarity("Dripping faucet in restroom", "Leaking tap in restroom");
  const diff = sim.textSimilarity("Dripping faucet in restroom", "Projector will not turn on");
  assert.ok(same > 0.3, "got " + same);
  assert.strictEqual(diff, 0);
});

test("photo fingerprints compare by differing bits", () => {
  assert.strictEqual(sim.hamming("0000000000000000", "0000000000000000"), 0);
  assert.strictEqual(sim.hamming("0000000000000000", "000000000000000f"), 4);
  assert.strictEqual(sim.hamming("zz", "0000000000000000"), null);
});

test("duplicates: same issue is found, unrelated issue is not", () => {
  const open = [
    { id: 1, title: "Leaking tap in restroom", description: "Sink tap drips all day", category: "Plumbing", building: "Lares Building", room: "Ground floor restroom", status: "Reported", hash: "", voters: ["a"] },
    { id: 2, title: "Room too cold", description: "Vent blows cold air", category: "HVAC", building: "Woodland Building", room: "Room 107", status: "Reported", hash: "", voters: ["b"] },
  ];
  const draft = { title: "Dripping faucet", description: "water leaking from the sink tap", category: "Plumbing", building: "Lares Building", room: "restroom", hash: "" };
  const found = sim.findSimilar(draft, open, cfg.duplicate);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].issue.id, 1);
  assert.ok(found[0].reasons.includes("Same building"));
  const other = sim.findSimilar({ title: "Broken chair", description: "chair leg snapped", category: "Furniture", building: "Library", room: "", hash: "" }, open, cfg.duplicate);
  assert.strictEqual(other.length, 0);
});

test("duplicates: a similar photo in the same building counts", () => {
  const open = [{ id: 1, title: "Thing", description: "Something odd", category: "Cleaning", building: "Library", room: "", status: "Reported", hash: "ffff0000ffff0000", voters: ["a"] }];
  const draft = { title: "Different words entirely", description: "nothing shared", category: "Furniture", building: "Library", room: "", hash: "ffff0000ffff0001" };
  const found = sim.findSimilar(draft, open, cfg.duplicate);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].reasons[0], "Photo looks alike");
  draft.building = "Rydal Building";
  assert.strictEqual(sim.findSimilar(draft, open, cfg.duplicate).length, 0);
});

test("category suggestion and safety words", () => {
  assert.strictEqual(sim.suggestCategory("the toilet is leaking", cfg.categories).category, "Plumbing");
  assert.deepStrictEqual(sim.findSafety("There is exposed wire near the door", cfg.safetyWords), ["exposed wire"]);
  assert.deepStrictEqual(sim.findSafety("The office is nice", cfg.safetyWords), []);
});

test("full journey over HTTP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campusfix-"));
  const server = createServer(dir);
  await new Promise((r) => server.listen(0, r));
  const base = "http://localhost:" + server.address().port;
  const alice = { "x-visitor": "visitor-alice-1" }, bob = { "x-visitor": "visitor-bob-0001" }, staff = { "x-visitor": "visitor-staff-01", "x-staff-pin": "1234" };
  const call = async (p, o = {}) => {
    const res = await fetch(base + p, { ...o, headers: { "content-type": "application/json", ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) });
    return { status: res.status, body: await res.json() };
  };

  // Alice reports something new
  const draft = { title: "Broken window latch", description: "The latch snapped off the window in the faculty lounge", category: "Doors & Windows", building: "Rydal Building", room: "Lounge" };
  assert.strictEqual((await call("/api/analyze", { method: "POST", headers: alice, body: draft })).body.similar.length, 0);
  const created = (await call("/api/issues", { method: "POST", headers: alice, body: draft })).body;
  assert.strictEqual(created.status, "Reported");
  assert.strictEqual(created.mine, true);

  // Bob is warned about the duplicate and upvotes instead of creating a new one
  const check = (await call("/api/analyze", { method: "POST", headers: bob, body: { ...draft, title: "Window latch broken", description: "latch came off the lounge window" } })).body;
  assert.strictEqual(check.similar[0].issue.id, created.id);
  const up = (await call(`/api/issues/${created.id}/upvote`, { method: "POST", headers: bob })).body;
  assert.strictEqual(up.votes, 2);
  await call(`/api/issues/${created.id}/upvote`, { method: "POST", headers: bob });
  assert.strictEqual(store(server, created.id).voters.length, 2, "double upvote must not count");

  // Only staff can change status
  assert.strictEqual((await call(`/api/issues/${created.id}/staff`, { method: "POST", headers: alice, body: { status: "Resolved" } })).status, 401);
  await call(`/api/issues/${created.id}/staff`, { method: "POST", headers: staff, body: { status: "In Progress", assignee: "Crew C (General)", note: "Part ordered" } });
  await call(`/api/issues/${created.id}/staff`, { method: "POST", headers: staff, body: { status: "Resolved" } });

  // Reporter says it is not fixed: it reopens. Non-voters cannot confirm.
  const carol = { "x-visitor": "visitor-carol-01" };
  assert.strictEqual((await call(`/api/issues/${created.id}/confirm`, { method: "POST", headers: carol, body: { fixed: true } })).status, 400);
  const reopened = (await call(`/api/issues/${created.id}/confirm`, { method: "POST", headers: alice, body: { fixed: false } })).body;
  assert.strictEqual(reopened.status, "In Progress");
  assert.strictEqual(reopened.reopened, 1);

  // Resolved again, this time confirmed
  await call(`/api/issues/${created.id}/staff`, { method: "POST", headers: staff, body: { status: "Resolved" } });
  const done = (await call(`/api/issues/${created.id}/confirm`, { method: "POST", headers: bob, body: { fixed: true } })).body;
  assert.strictEqual(done.confirmedFixed, true);

  // Safety wording is flagged urgent, bad input is rejected, voter ids are never exposed
  const hazard = (await call("/api/issues", { method: "POST", headers: alice, body: { ...draft, title: "Exposed wire", description: "exposed wire hanging by the door" } })).body;
  assert.strictEqual(hazard.priority, "Urgent");
  assert.strictEqual((await call("/api/issues", { method: "POST", headers: alice, body: { ...draft, category: "Nope" } })).status, 400);
  const list = (await call("/api/issues", { headers: alice })).body;
  assert.ok(!JSON.stringify(list).includes("visitor-alice-1"));
  assert.strictEqual((await call("/api/issues")).status, 400);

  // Staff tools: only staff can delete a report or wipe everything
  assert.strictEqual((await call(`/api/issues/${hazard.id}/delete`, { method: "POST", headers: alice })).status, 401);
  assert.strictEqual((await call("/api/reset", { method: "POST", headers: alice, body: { mode: "empty" } })).status, 401);
  assert.strictEqual((await call(`/api/issues/${hazard.id}/delete`, { method: "POST", headers: staff })).status, 200);
  assert.strictEqual((await call(`/api/issues/${hazard.id}/delete`, { method: "POST", headers: staff })).status, 404);
  await call("/api/reset", { method: "POST", headers: staff, body: { mode: "empty" } });
  assert.strictEqual((await call("/api/issues", { headers: alice })).body.length, 0);
  await call("/api/reset", { method: "POST", headers: staff, body: { mode: "sample" } });
  assert.strictEqual((await call("/api/issues", { headers: alice })).body.length, 10);

  server.close();
});

function store(server, id) {
  return server.store.find(id);
}
