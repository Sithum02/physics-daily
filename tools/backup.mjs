// ==========================================================
// Database backup → content/backups/latest/*.json  (private; the content folder is its own private git repo)
//
//   node tools/backup.mjs          back up now
//   import { backup } from "./backup.mjs"   (publish.mjs calls it, at most once a day)
//
// Each run overwrites the "latest" files; git history keeps every older version.
// ==========================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "content", "backups", "latest");

// Everything in the shared Supabase project (daily app + class website)
const TABLES = [
  "profiles", "dq_days", "dq_questions", "dq_keys", "dq_attempts", "dq_responses", "dq_reports", "dq_push_subs",
  "courses", "enrollments", "papers", "questions", "question_keys", "attempts", "materials"
];

function env() {
  return Object.fromEntries(readFileSync(join(root, "tools", ".env"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

async function fetchAll(url, key, table) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
      headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
        "Range-Unit": "items", Range: `${from}-${from + page - 1}` }
    });
    if (res.status === 404) return null; // table doesn't exist (e.g. website not set up)
    if (!res.ok && res.status !== 206) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < page) return rows;
  }
}

export async function backup({ quiet = false } = {}) {
  const e = env();
  const url = e.SUPABASE_URL.replace(/\/$/, "");
  mkdirSync(outDir, { recursive: true });
  const counts = {};
  for (const t of TABLES) {
    const rows = await fetchAll(url, e.SUPABASE_SERVICE_KEY, t);
    if (rows == null) continue;
    writeFileSync(join(outDir, `${t}.json`), JSON.stringify(rows, null, 1));
    counts[t] = rows.length;
  }
  writeFileSync(join(outDir, "_info.json"), JSON.stringify({ taken_at: new Date().toISOString(), counts }, null, 2));
  if (!quiet) console.log(`✓ backup: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  return counts;
}

export function lastBackupAge() {
  const f = join(outDir, "_info.json");
  if (!existsSync(f)) return Infinity;
  return Date.now() - Date.parse(JSON.parse(readFileSync(f, "utf8")).taken_at);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await backup();
