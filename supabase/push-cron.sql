-- Daily reminder schedule. Run with the real secret substituted for CRON_SECRET_HERE
-- (tools/setup-push.mjs does this automatically — don't commit the real secret).
-- Times are UTC: 00:30 UTC = 6:00 am Sri Lanka, 14:30 UTC = 8:00 pm Sri Lanka.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('dq-morning-push', '30 0 * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/daily-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'CRON_SECRET_HERE'),
    body := jsonb_build_object('kind', 'morning'));
$$);

select cron.schedule('dq-evening-push', '30 14 * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/daily-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'CRON_SECRET_HERE'),
    body := jsonb_build_object('kind', 'evening'));
$$);
