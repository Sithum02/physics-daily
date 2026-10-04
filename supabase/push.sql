-- ==========================================================
-- Physics Daily — push reminders (run after daily.sql; safe to run again)
-- Phones subscribe from the app; the "daily-push" Edge Function sends the messages.
-- ==========================================================

create table if not exists public.dq_push_subs (
  endpoint    text primary key,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
alter table public.dq_push_subs enable row level security;   -- no policies: functions only

-- The app saves this phone's subscription (from PushSubscription.toJSON()).
create or replace function public.dq_push_subscribe(p_sub jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in'; end if;
  insert into dq_push_subs (endpoint, student_id, p256dh, auth)
  values (p_sub ->> 'endpoint', auth.uid(), p_sub -> 'keys' ->> 'p256dh', p_sub -> 'keys' ->> 'auth')
  on conflict (endpoint) do update
    set student_id = excluded.student_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.dq_push_unsubscribe(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from dq_push_subs where endpoint = p_endpoint and student_id = auth.uid();
end $$;

-- Who gets a message, and what it says.
--   morning → everyone (only if today has a quiz)
--   evening → only students who haven't submitted today's quiz yet
--   custom  → everyone (title/body supplied by the admin)
create or replace function public.dq_push_targets(p_kind text) returns json
language plpgsql security definer set search_path = public as $$
declare t date := lk_today(); n int; ttl text;
begin
  perform dq_require_admin();
  select count(*) into n from dq_questions where day = t;
  select title into ttl from dq_days where day = t;
  if p_kind in ('morning', 'evening') and n = 0 then
    return json_build_object('subs', '[]'::json, 'reason', 'no quiz today');
  end if;

  -- 6 pm check for the admin: warn if tomorrow has no questions yet
  if p_kind = 'admin_alert' then
    if exists (select 1 from dq_questions where day = t + 1) then
      return json_build_object('subs', '[]'::json, 'reason', 'tomorrow is scheduled');
    end if;
    return json_build_object(
      'title', '⚠️ No quiz scheduled for tomorrow',
      'body', to_char(t + 1, 'Dy DD Mon') || ' has no questions yet. Open VS Code and ask Claude to add tomorrow''s quiz.',
      'subs', coalesce((
        select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
        from dq_push_subs s join profiles p on p.id = s.student_id where p.is_admin), '[]'::json));
  end if;

  return json_build_object(
    'title', case p_kind
      when 'morning' then '🔬 Today''s quiz is live · Sithum De Zoysa'
      when 'evening' then '⏳ 4 hours left · Sithum De Zoysa' end,
    'body', case p_kind
      when 'morning' then n || ' new MCQs' || coalesce(' · ' || nullif(ttl, ''), '') || '. Closes at midnight.'
      when 'evening' then 'You haven''t done today''s ' || n || ' questions yet. Keep your 🔥 streak going!' end,
    'subs', coalesce((
      select json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
      from dq_push_subs s join profiles p on p.id = s.student_id
      where not p.is_banned
        and (p_kind <> 'evening' or not exists (
              select 1 from dq_attempts a where a.student_id = s.student_id and a.day = t and a.submitted_at is not null))
    ), '[]'::json)
  );
end $$;

-- Remove subscriptions the push service says are gone (app uninstalled, permission revoked…).
create or replace function public.dq_push_remove(p_endpoints text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  delete from dq_push_subs where endpoint = any(p_endpoints);
end $$;

create or replace function public.dq_admin_push_count() returns int
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  return (select count(distinct student_id) from dq_push_subs);
end $$;

-- Is this phone subscribed for me?
create or replace function public.dq_push_status(p_endpoint text) returns boolean
language sql security definer set search_path = public as $$
  select exists (select 1 from dq_push_subs where endpoint = p_endpoint and student_id = auth.uid());
$$;
