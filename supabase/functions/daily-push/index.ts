// Supabase Edge Function: sends Physics Daily push reminders.
// Called by the database scheduler (morning / evening, with x-cron-secret)
// or by the admin panel ("custom" message, with the admin's login token).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SERVICE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
webpush.setVapidDetails("mailto:sithumdezoysa02@gmail.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret"
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function allowed(req: Request) {
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) return true;
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await db.auth.getUser(token);
  if (!data.user) return false;
  const { data: p } = await db.from("profiles").select("is_admin").eq("id", data.user.id).single();
  return !!p?.is_admin;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await allowed(req))) return json({ error: "Not allowed" }, 401);

  const body = await req.json().catch(() => ({}));
  const kind = ["morning", "evening", "admin_alert"].includes(body.kind) ? body.kind : "custom";
  const { data: t, error } = await db.rpc("dq_push_targets", { p_kind: kind });
  if (error) return json({ error: error.message }, 500);

  const title = kind === "custom" ? String(body.title || "Physics Daily").slice(0, 80) : t.title;
  const text = kind === "custom" ? String(body.body || "").slice(0, 200) : t.body;
  const payload = JSON.stringify({ title, body: text, url: "./" });
  const subs = (t.subs || []) as { endpoint: string; p256dh: string; auth: string }[];

  const gone: string[] = [];
  let sent = 0;
  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
    }
  }));
  if (gone.length) await db.rpc("dq_push_remove", { p_endpoints: gone });

  return json({ kind, sent, removed: gone.length, total: subs.length, reason: t.reason ?? null });
});
