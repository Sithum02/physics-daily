// Checks every question file and rebuilds data/index.json.
// Run from the "Mobile App" folder:   node tools/build.mjs
// Exits with an error (and publishes nothing) if any question is broken.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const daysDir = join(root, "data", "days");
const errors = [], warnings = [];
const seenIds = new Set();
const days = [];

for (const file of readdirSync(daysDir).filter((f) => f.endsWith(".json")).sort()) {
  const where = `data/days/${file}`;
  let day;
  try { day = JSON.parse(readFileSync(join(daysDir, file), "utf8")); }
  catch (e) { errors.push(`${where}: not valid JSON (${e.message})`); continue; }

  const date = file.replace(".json", "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`${where}: file name must be YYYY-MM-DD.json`);
  if (day.date !== date) errors.push(`${where}: "date" must be "${date}"`);
  if (!Array.isArray(day.questions) || !day.questions.length) { errors.push(`${where}: no questions`); continue; }

  const topics = new Set();
  day.questions.forEach((q, i) => {
    const at = `${where} Q${i + 1}`;
    const expectId = `${date}-${String(i + 1).padStart(2, "0")}`;
    if (q.id !== expectId) errors.push(`${at}: id should be "${expectId}"`);
    if (seenIds.has(q.id)) errors.push(`${at}: duplicate id ${q.id}`);
    seenIds.add(q.id);
    if (!q.q || !String(q.q).trim()) errors.push(`${at}: empty question text`);
    if (!Array.isArray(q.options) || q.options.length !== 5) errors.push(`${at}: needs exactly 5 options`);
    else {
      if (q.options.some((o) => !String(o).trim())) errors.push(`${at}: an option is empty`);
      if (new Set(q.options.map((o) => String(o).trim())).size !== 5) errors.push(`${at}: two options are identical`);
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 4) errors.push(`${at}: "answer" must be 0–4 (A=0 … E=4)`);
    if (!q.explain) warnings.push(`${at}: no method/explanation`);
    if (q.image && !existsSync(join(root, q.image))) errors.push(`${at}: image not found: ${q.image}`);
    const unclosed = String(q.q + (q.explain || "")).match(/[\^_]\{[^}]*$/);
    if (unclosed) errors.push(`${at}: unclosed ^{ or _{`);
    if (q.topic) topics.add(q.topic);
  });

  // answer-letter spread (warn if a day is lopsided, e.g. every answer is C)
  const spread = [0, 0, 0, 0, 0];
  day.questions.forEach((q) => Number.isInteger(q.answer) && spread[q.answer]++);
  if (day.questions.length >= 5 && Math.max(...spread) > Math.ceil(day.questions.length / 2)) {
    warnings.push(`${where}: answers are lopsided (A–E counts: ${spread.join(", ")})`);
  }

  days.push({ date, title: day.title || "", count: day.questions.length, topics: [...topics] });
}

warnings.forEach((w) => console.log("⚠ " + w));
if (errors.length) {
  errors.forEach((e) => console.log("✗ " + e));
  console.log(`\n${errors.length} error(s). Nothing was written.`);
  process.exit(1);
}

days.sort((a, b) => b.date.localeCompare(a.date));
writeFileSync(join(root, "data", "index.json"),
  JSON.stringify({ updated: new Date().toISOString(), days }, null, 2) + "\n");

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const future = days.filter((d) => d.date > today);
console.log(`✓ ${days.length} day(s), ${seenIds.size} questions. index.json updated.`);
if (future.length) console.log(`  Scheduled ahead: ${future.map((d) => d.date).reverse().join(", ")}`);
