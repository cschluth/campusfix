// All the "smart" logic lives here as plain functions, so it is easy to read and test.
// 1. Text similarity   2. Photo similarity   3. Match scoring   4. Category + safety hints   5. Staff priority

const STOP = new Set("a an the is are was were in on at of to for and or it its this that there with my has have be been by from not no very really all day".split(" "));
// Different words people use for the same thing.
const SYN = {
  light: "lamp", bulb: "lamp", tap: "faucet", sink: "faucet", outlet: "socket", plug: "socket",
  drip: "leak", jammed: "stuck", jam: "stuck", broke: "broken", wifi: "internet", network: "internet",
};

function stem(w) {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
}

function tokens(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.filter((w) => !STOP.has(w)).map((w) => SYN[w] || SYN[stem(w)] || stem(w));
}

// ---- 1. Text similarity: cosine similarity of word counts (0 = nothing shared, 1 = identical)
function counts(words) {
  const m = {};
  for (const w of words) m[w] = (m[w] || 0) + 1;
  return m;
}
function textSimilarity(a, b) {
  const x = counts(tokens(a)), y = counts(tokens(b));
  let dot = 0, nx = 0, ny = 0;
  for (const k in x) { nx += x[k] ** 2; if (y[k]) dot += x[k] * y[k]; }
  for (const k in y) ny += y[k] ** 2;
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

// ---- 2. Photo similarity: the browser makes a 64-bit "fingerprint" of each photo (a difference hash).
// Two photos of the same thing have fingerprints that differ in only a few bits.
function hamming(h1, h2) {
  if (!/^[0-9a-f]{16}$/.test(h1 || "") || !/^[0-9a-f]{16}$/.test(h2 || "")) return null;
  let x = BigInt("0x" + h1) ^ BigInt("0x" + h2), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// ---- 3. Match scoring: combine wording, photo, and location into one score with reasons.
function scoreMatch(draft, issue, cfg) {
  const text = textSimilarity(draft.title + " " + draft.description, issue.title + " " + issue.description);
  const dist = hamming(draft.hash, issue.hash);
  const sameBuilding = !!draft.building && draft.building === issue.building;
  const sameCategory = !!draft.category && draft.category === issue.category;
  const sameRoom = sameBuilding && !!draft.room && !!issue.room && tokens(draft.room).some((w) => tokens(issue.room).includes(w));
  const photoAlike = dist !== null && dist <= cfg.photoMaxDistance && sameBuilding;

  let score = 0.6 * text;
  const reasons = [];
  if (text >= 0.15) reasons.push("Similar wording");
  if (text >= 0.15 || photoAlike) {
    // Location and category only add weight when something else already links the two reports.
    if (sameBuilding) { score += 0.15; reasons.push("Same building"); }
    if (sameRoom) { score += 0.05; reasons.push("Same room"); }
    if (sameCategory) { score += 0.1; reasons.push("Same category"); }
  }
  if (photoAlike) { score += 0.35; reasons.unshift("Photo looks alike"); }
  return { score: Math.min(score, 0.99), reasons, text, photoDistance: dist };
}

function strength(score) {
  return score >= 0.6 ? "Strong match" : score >= 0.45 ? "Likely match" : "Possible match";
}

function findSimilar(draft, issues, cfg) {
  return issues
    .filter((i) => i.status !== "Resolved")
    .map((issue) => ({ issue, ...scoreMatch(draft, issue, cfg) }))
    .filter((m) => m.score >= cfg.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => ({ ...m, strength: strength(m.score) }));
}

// ---- 4. Hints: suggest a category, and spot safety hazards. Both are only suggestions.
function suggestCategory(text, categories) {
  const found = new Set(tokens(text));
  let best = null;
  for (const [category, words] of Object.entries(categories)) {
    const matched = words.filter((w) => found.has(SYN[w] || SYN[stem(w)] || stem(w)));
    if (matched.length && (!best || matched.length > best.matched.length)) best = { category, matched };
  }
  return best;
}

function findSafety(text, safetyWords) {
  const t = " " + String(text).toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  return safetyWords.filter((w) => t.includes(" " + w + " "));
}

// ---- 5. Staff priority: a transparent score so staff can see why something is at the top.
function priority(issue, cfg, now = Date.now()) {
  if (issue.status === "Resolved") return { score: 0, parts: [], overdue: false };
  const ageDays = (now - issue.createdAt) / 864e5;
  const parts = [];
  if (issue.priority === "Urgent") parts.push({ label: "Marked urgent", points: 40 });
  if (issue.category === "Safety") parts.push({ label: "Safety issue", points: 25 });
  const votes = issue.voters.length;
  if (votes > 1) parts.push({ label: `${votes} reports`, points: Math.min(votes, 10) * 4 });
  if (ageDays >= 1) parts.push({ label: `${Math.floor(ageDays)} days old`, points: Math.min(Math.floor(ageDays), 14) * 2 });
  if (issue.reopened) parts.push({ label: "Reopened", points: 15 });
  const overdue = ageDays > (cfg.slaDays[issue.priority] ?? 5);
  return { score: parts.reduce((s, p) => s + p.points, 0), parts, overdue };
}

module.exports = { tokens, textSimilarity, hamming, scoreMatch, findSimilar, suggestCategory, findSafety, priority };
