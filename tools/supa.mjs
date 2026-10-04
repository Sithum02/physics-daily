// ==========================================================
// Admin helper for the Supabase project (uses the private tools/.env).
//
//   node tools/supa.mjs sql supabase/push.sql     run a SQL file on the live database
//   node tools/supa.mjs push-setup                push reminders: SQL, secrets, function, schedule
//   node tools/supa.mjs test-push "Title" "Body"  send a notification to everyone subscribed
//
// Needs SUPABASE_ACCESS_TOKEN (supabase.com → Account → Access Tokens) in tools/.env.
// ==========================================================
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(readFileSync(join(root, "tools", ".env"), "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const URL_ = env.SUPABASE_URL.replace(/\/$/, "");
const REF = URL_.match(/https:\/\/([^.]+)\./)[1];
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const [cmd, ...rest] = process.argv.slice(2);

function need(name) {
  if (!env[name] || env[name].startsWith("paste")) { console.log(`✗ ${name} is missing in tools/.env`); process.exit(1); }
}

async function mgmt(path, body, method = "POST") {
  need("SUPABASE_ACCESS_TOKEN");
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const sql = (query) => mgmt("database/query", { query });

if (cmd === "sql") {
  const file = rest[0];
  if (!file || !existsSync(join(root, file))) { console.log("Usage: node tools/supa.mjs sql <file.sql>"); process.exit(1); }
  const out = await sql(readFileSync(join(root, file), "utf8"));
  console.log(`✓ ran ${file}`, Array.isArray(out) && out.length ? JSON.stringify(out).slice(0, 400) : "");
}

else if (cmd === "push-setup") {
  need("VAPID_PUBLIC"); need("VAPID_PRIVATE"); need("CRON_SECRET"); need("SUPABASE_SERVICE_KEY");
  await sql(readFileSync(join(root, "supabase", "push.sql"), "utf8"));
  console.log("✓ push tables and functions");
  await mgmt("secrets", [
    { name: "SERVICE_KEY", value: env.SUPABASE_SERVICE_KEY },
    { name: "VAPID_PUBLIC", value: env.VAPID_PUBLIC },
    { name: "VAPID_PRIVATE", value: env.VAPID_PRIVATE },
    { name: "CRON_SECRET", value: env.CRON_SECRET }
  ]);
  console.log("✓ function secrets");
  execSync(`npx -y supabase@latest functions deploy daily-push --project-ref ${REF} --no-verify-jwt --use-api`, {
    cwd: root, stdio: "inherit", env: { ...process.env, SUPABASE_ACCESS_TOKEN: TOKEN }
  });
  console.log("✓ daily-push function deployed");
  await sql(readFileSync(join(root, "supabase", "push-cron.sql"), "utf8")
    .replaceAll("CRON_SECRET_HERE", env.CRON_SECRET).replaceAll("PROJECT_REF", REF));
  console.log("✓ schedule: 6:00 am and 8:00 pm Sri Lanka time");
}

else if (cmd === "test-push") {
  need("CRON_SECRET");
  const res = await fetch(`${URL_}/functions/v1/daily-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": env.CRON_SECRET },
    body: JSON.stringify({ kind: ["morning", "evening", "admin_alert"].includes(rest[0]) ? rest[0] : "custom",
      title: rest[0] || "Test from Physics Daily", body: rest[1] || "Notifications are working 🎉" })
  });
  console.log(res.status, await res.text());
}

else if (cmd === "smtp-setup") {
  // Send login / password emails through Brevo (free: 300/day) instead of Supabase's 2-per-hour test mailer
  need("BREVO_SMTP_LOGIN"); need("BREVO_SMTP_KEY"); need("SENDER_EMAIL");
  const appUrl = "https://sithum02.github.io/physics-daily/";
  const mail = (heading, text, button) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 4px">Physics Daily</h2><p style="margin:0 0 20px;color:#55607a">සත්කාර · by <b>Sithum De Zoysa</b></p>
    <h3 style="margin:0 0 8px">${heading}</h3><p style="color:#334155;line-height:1.6">${text}</p>
    <p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#ffc53d;color:#1a1300;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:bold">${button}</a></p>
    <p style="color:#8a93ab;font-size:12px">If you didn't ask for this, you can ignore this email.<br>Physics Daily · ${appUrl}</p></div>`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
    method: "PATCH", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      smtp_host: "smtp-relay.brevo.com", smtp_port: "587",
      smtp_user: env.BREVO_SMTP_LOGIN, smtp_pass: env.BREVO_SMTP_KEY,
      smtp_admin_email: env.SENDER_EMAIL, smtp_sender_name: "Physics Daily · Sithum De Zoysa",
      rate_limit_email_sent: 100,
      mailer_subjects_recovery: "Reset your Physics Daily password",
      mailer_templates_recovery_content: mail("Reset your password", "Tap the button below to choose a new password for your Physics Daily account.", "Set a new password"),
      mailer_subjects_confirmation: "Confirm your Physics Daily account",
      mailer_templates_confirmation_content: mail("Welcome! 🎉", "Tap the button below to confirm your email and start your daily A/L Physics quizzes.", "Confirm my email")
    })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.log("✗", res.status, JSON.stringify(out).slice(0, 300)); process.exit(1); }
  console.log(`✓ emails now sent via Brevo from ${out.smtp_admin_email} (limit ${out.rate_limit_email_sent}/hour)`);
}

else {
  console.log("Commands: sql <file> | push-setup | test-push [title|morning|evening|admin_alert] [body] | smtp-setup");
}
