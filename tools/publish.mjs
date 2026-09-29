// ==========================================================
// Checks the question files and uploads them to the database.
//
//   node tools/publish.mjs            → check everything, upload days that changed
//   node tools/publish.mjs --check    → only check, upload nothing
//   node tools/publish.mjs 2026-10-02 → force-upload specific day(s)
//
// Question files: content/days/YYYY-MM-DD.json   (private, never pushed to GitHub)
// Secret key:     tools/.env                      (private)
// ==========================================================
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const daysDir = join(root, "content", "days");
const stampFile = join(root, "content", ".published.json");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const forced = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

// ---------- 1. Validate ----------
const errors = [], warnings = [], days = [];
const seen = new Set();

for (const file of readdirSync(daysDir).filter((f) => f.endsWith(".json")).sort()) {
  const where = `content/days/${file}`;
  const raw = readFileSync(join(daysDir, file), "utf8");
  let day;
  try { day = JSON.parse(raw); } catch (e) { errors.push(`${where}: not valid JSON (${e.message})`); continue; }

  const date = file.replace(".json", "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`${where}: file name must be YYYY-MM-DD.json`);
  if (day.date !== date) errors.push(`${where}: "date" must be "${date}"`);
  if (!Array.isArray(day.questions) || !day.questions.length) { errors.push(`${where}: no questions`); continue; }

  day.questions.forEach((q, i) => {
    const at = `${where} Q${i + 1}`;
    const id = `${date}-${String(i + 1).padStart(2, "0")}`;
    if (q.id !== id) errors.push(`${at}: id should be "${id}"`);
    if (seen.has(q.id)) errors.push(`${at}: duplicate id`);
    seen.add(q.id);
    if (!String(q.q || "").trim()) errors.push(`${at}: empty question`);
    if (!Array.isArray(q.options) || q.options.length !== 5) errors.push(`${at}: needs exactly 5 options`);
    else {
      if (q.options.some((o) => !String(o).trim())) errors.push(`${at}: an option is empty`);
      if (new Set(q.options.map((o) => String(o).trim())).size !== 5) errors.push(`${at}: two options are identical`);
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 4) errors.push(`${at}: "answer" must be 0–4 (A=0 … E=4)`);
    if (!q.explain) warnings.push(`${at}: no method/explanation`);
    if (q.image && !existsSync(join(root, q.image))) errors.push(`${at}: image not found: ${q.image}`);
    if (/[\^_]\{[^}]*$/.test(String(q.q) + " " + String(q.explain || ""))) errors.push(`${at}: unclosed ^{ or _{`);
  });

  const spread = [0, 0, 0, 0, 0];
  day.questions.forEach((q) => Number.isInteger(q.answer) && spread[q.answer]++);
  if (day.questions.length >= 5 && Math.max(...spread) > Math.ceil(day.questions.length / 2)) {
    warnings.push(`${where}: answers are lopsided (A–E: ${spread.join(", ")})`);
  }
  days.push({ date, day, hash: createHash("sha1").update(raw).digest("hex") });
}

warnings.forEach((w) => console.log("⚠ " + w));
if (errors.length) {
  errors.forEach((e) => console.log("✗ " + e));
  console.log(`\n${errors.length} error(s). Nothing was uploaded.`);
  process.exit(1);
}
console.log(`✓ ${days.length} day file(s), ${seen.size} questions, all valid.`);
if (checkOnly) process.exit(0);

// ---------- 2. Upload ----------
const envPath = join(root, "tools", ".env");
if (!existsSync(envPath)) { console.log("✗ tools/.env is missing (see WORKFLOW.md)."); process.exit(1); }
const env = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const URL_ = (env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY || KEY.startsWith("paste")) { console.log("✗ Fill in SUPABASE_URL and SUPABASE_SERVICE_KEY in tools/.env"); process.exit(1); }

async function api(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, "Content-Type": "application/json",
      // Old-style keys are JWTs and also go in Authorization; new sb_secret_ keys only go in apikey
      ...(KEY.startsWith("eyJ") ? { Authorization: `Bearer ${KEY}` } : {}),
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

let stamps = {};
try { stamps = JSON.parse(readFileSync(stampFile, "utf8")); } catch { /* first run */ }

const todo = days.filter((d) => forced.length ? forced.includes(d.date) : stamps[d.date] !== d.hash);
if (!todo.length) { console.log("Nothing changed since the last upload."); process.exit(0); }

for (const { date, day, hash } of todo) {
  await api("dq_days?on_conflict=day", { method: "POST", prefer: "resolution=merge-duplicates", body: [{ day: date, title: day.title || "" }] });

  const qRows = day.questions.map((q, i) => ({
    id: q.id, day: date, position: i + 1, topic: q.topic || "", body: q.q,
    image_url: q.image || null, options: q.options.map(String)
  }));
  await api("dq_questions?on_conflict=id", { method: "POST", prefer: "resolution=merge-duplicates", body: qRows });
  await api("dq_keys?on_conflict=question_id", {
    method: "POST", prefer: "resolution=merge-duplicates",
    body: day.questions.map((q) => ({ question_id: q.id, correct_index: q.answer, explanation: q.explain || "" }))
  });

  // Remove questions that were deleted from the file
  const live = await api(`dq_questions?day=eq.${date}&select=id`);
  const extra = live.map((r) => r.id).filter((id) => !seen.has(id));
  if (extra.length) await api(`dq_questions?id=in.(${extra.map(encodeURIComponent).join(",")})`, { method: "DELETE" });

  // Re-mark anyone who already sat this day (e.g. after an answer fix)
  const regraded = await api("rpc/dq_regrade_day", { method: "POST", body: { p_day: date } });
  stamps[date] = hash;
  console.log(`↑ ${date}  "${day.title || ""}"  ${qRows.length} questions${extra.length ? `, removed ${extra.length}` : ""}${regraded ? `, re-marked ${regraded} attempt(s)` : ""}`);
}

writeFileSync(stampFile, JSON.stringify(stamps, null, 2));
const t = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // Sri Lanka date
const ahead = days.filter((d) => d.date > t).map((d) => d.date);
console.log(`Done.${ahead.length ? ` Scheduled ahead: ${ahead.join(", ")}` : ""}`);
