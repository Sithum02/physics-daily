-- ==========================================================
-- Physics Daily (mobile app) — database
-- Adds to the SAME Supabase project as the website.
-- Run AFTER the website's schema.sql, once, in Supabase → SQL Editor.
-- ==========================================================

-- ---------- Profile additions ----------
alter table public.profiles
  add column if not exists nic        text,
  add column if not exists is_banned  boolean not null default false,
  add column if not exists ban_reason text    not null default '';
create unique index if not exists profiles_nic_key on public.profiles (nic) where nic is not null;

-- "Today" is always Sri Lanka time, decided by the server (changing the phone clock does nothing).
create or replace function public.lk_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Colombo')::date $$;

-- Sri Lankan NIC → normalised 12-digit form, or null if invalid.
-- Old: YYDDDSSSC + V/X   New: YYYYDDDSSSSC   (DDD = day of year, +500 for female)
create or replace function public.normalize_nic(p text) returns text
language plpgsql stable as $$
declare
  s text := upper(regexp_replace(coalesce(p, ''), '[\s-]', '', 'g'));
  y int; d int;
begin
  if s ~ '^\d{9}[VX]$' then
    s := '19' || substr(s, 1, 5) || '0' || substr(s, 6, 4);
  elsif s !~ '^\d{12}$' then
    return null;
  end if;
  y := substr(s, 1, 4)::int;
  d := substr(s, 5, 3)::int;
  if d > 500 then d := d - 500; end if;
  if d < 1 or d > 366 then return null; end if;
  if y < 1960 or y > extract(year from now())::int - 13 then return null; end if;
  return s;
end $$;

-- A student sets their own NIC once (only the admin can change it afterwards).
create or replace function public.set_my_nic(p_nic text) returns text
language plpgsql security definer set search_path = public as $$
declare n text := public.normalize_nic(p_nic);
begin
  if auth.uid() is null then raise exception 'Please log in'; end if;
  if n is null then raise exception 'That NIC number is not valid'; end if;
  if exists (select 1 from profiles where id = auth.uid() and nic is not null) then
    raise exception 'Your NIC is already saved. Contact the admin to change it';
  end if;
  if exists (select 1 from profiles where nic = n) then
    raise exception 'This NIC is already registered to another account. Contact the admin';
  end if;
  update profiles set nic = n where id = auth.uid();
  return n;
end $$;

-- ---------- Tables ----------
create table if not exists public.dq_days (
  day         date primary key,
  title       text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.dq_questions (
  id         text primary key,                 -- e.g. 2026-09-30-01
  day        date not null references public.dq_days(day) on delete cascade,
  position   int  not null,
  topic      text not null default '',
  body       text not null,
  image_url  text,
  options    text[] not null check (array_length(options, 1) = 5)
);
create index if not exists dq_questions_day on public.dq_questions (day);

-- Answers: never readable by students directly.
create table if not exists public.dq_keys (
  question_id    text primary key references public.dq_questions(id) on delete cascade,
  correct_index  int  not null check (correct_index between 0 and 4),
  explanation    text not null default ''
);

create table if not exists public.dq_attempts (
  id            uuid primary key default gen_random_uuid(),
  day           date not null references public.dq_days(day) on delete cascade,
  student_id    uuid not null references public.profiles(id) on delete cascade,
  started_at    timestamptz not null default now(),
  deadline      timestamptz not null,
  submitted_at  timestamptz,
  perms         jsonb not null default '{}'::jsonb,  -- { qid: [original option index shown at position 0..4] }
  answers       jsonb not null default '{}'::jsonb,  -- { qid: position the student picked (0..4) }
  score         int,
  total         int,
  time_taken    int,                                 -- seconds
  unique (day, student_id)
);
create index if not exists dq_attempts_student on public.dq_attempts (student_id);

create table if not exists public.dq_responses (
  attempt_id   uuid not null references public.dq_attempts(id) on delete cascade,
  question_id  text not null references public.dq_questions(id) on delete cascade,
  chosen       int,                 -- original option index, null = skipped
  is_correct   boolean not null,
  primary key (attempt_id, question_id)
);

alter table public.dq_days      enable row level security;
alter table public.dq_questions enable row level security;
alter table public.dq_keys      enable row level security;
alter table public.dq_attempts  enable row level security;
alter table public.dq_responses enable row level security;

-- Students go through the functions below; the admin can also read tables directly.
drop policy if exists "dq_days admin" on public.dq_days;
create policy "dq_days admin" on public.dq_days for select using (public.is_admin());
drop policy if exists "dq_questions admin" on public.dq_questions;
create policy "dq_questions admin" on public.dq_questions for select using (public.is_admin());
drop policy if exists "dq_keys admin" on public.dq_keys;
create policy "dq_keys admin" on public.dq_keys for select using (public.is_admin());
drop policy if exists "dq_attempts admin" on public.dq_attempts;
create policy "dq_attempts admin" on public.dq_attempts for select using (public.is_admin());
drop policy if exists "dq_responses admin" on public.dq_responses;
create policy "dq_responses admin" on public.dq_responses for select using (public.is_admin());

-- ---------- Languages (English always; Sinhala / Tamil optional per question) ----------
alter table public.dq_questions
  add column if not exists body_si    text,
  add column if not exists body_ta    text,
  add column if not exists options_si text[],
  add column if not exists options_ta text[];
alter table public.dq_keys
  add column if not exists explanation_si text,
  add column if not exists explanation_ta text;
alter table public.profiles add column if not exists lang text not null default 'en';
do $$ begin
  alter table public.profiles add constraint profiles_lang_check check (lang in ('en', 'si', 'ta'));
exception when duplicate_object then null; end $$;
grant update (lang) on public.profiles to authenticated;

-- Reorder a 5-option array by an attempt's shuffle (null array → null).
create or replace function public.dq_shuffled(arr text[], perm jsonb) returns json
language sql immutable as $$
  select case when arr is null then null else (
    select json_agg(arr[e.v::int + 1] order by e.ord)
    from jsonb_array_elements_text(coalesce(perm, '[0,1,2,3,4]'::jsonb)) with ordinality e(v, ord)) end
$$;

-- ---------- Grading ----------
-- Position picked → original option via this attempt's shuffle.
create or replace function public.dq_orig(a public.dq_attempts, qid text) returns int
language sql immutable as $$
  select case when a.answers ? qid and jsonb_typeof(a.answers -> qid) = 'number'
    then (coalesce(a.perms -> qid, '[0,1,2,3,4]'::jsonb) ->> (a.answers ->> qid)::int)::int end
$$;

create or replace function public.dq_grade(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a dq_attempts;
begin
  select * into a from dq_attempts where id = p_attempt;
  if not found then return; end if;
  delete from dq_responses where attempt_id = a.id;
  insert into dq_responses (attempt_id, question_id, chosen, is_correct)
  select a.id, q.id, dq_orig(a, q.id), coalesce(dq_orig(a, q.id) = k.correct_index, false)
  from dq_questions q left join dq_keys k on k.question_id = q.id
  where q.day = a.day;
  update dq_attempts set
    score = (select count(*) from dq_responses r where r.attempt_id = a.id and r.is_correct),
    total = (select count(*) from dq_questions q where q.day = a.day)
  where id = a.id;
end $$;

-- Anyone who ran out of time without submitting gets submitted with their last saved answers.
create or replace function public.dq_finalize_expired() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select id from dq_attempts
    where submitted_at is null and deadline + interval '30 seconds' < now()
    for update skip locked
  loop
    update dq_attempts
       set submitted_at = deadline,
           time_taken = extract(epoch from deadline - started_at)::int
     where id = r.id;
    perform dq_grade(r.id);
  end loop;
end $$;

-- ---------- Student functions ----------
create or replace function public.dq_me() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  select * into p from profiles where id = auth.uid();
  if not found then raise exception 'Please log in'; end if;
  return p;
end $$;

-- Home screen: released days + my status on each.
create or replace function public.dq_home() returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t date := lk_today();
begin
  if uid is null then raise exception 'Please log in'; end if;
  perform dq_finalize_expired();
  return json_build_object(
    'today', t,
    'now', now(),
    'days', coalesce((
      select json_agg(x order by x.day desc) from (
        select d.day, d.title,
               (select count(*) from dq_questions q where q.day = d.day) as count,
               (select array_agg(distinct q.topic) from dq_questions q where q.day = d.day and q.topic <> '') as topics,
               a.started_at, a.deadline, a.submitted_at, a.score, a.total, a.time_taken
        from dq_days d
        left join dq_attempts a on a.day = d.day and a.student_id = uid
        where d.day <= t and exists (select 1 from dq_questions q where q.day = d.day)
        order by d.day desc
        limit 120
      ) x), '[]'::json)
  );
end $$;

-- Start (or resume) today's quiz. Options come back shuffled; answers are never sent.
create or replace function public.dq_start(p_day date) returns json
language plpgsql security definer set search_path = public as $$
declare p profiles; a dq_attempts; n int;
begin
  p := dq_me();
  if p.is_banned then raise exception 'Your account has been suspended. Please contact the admin'; end if;
  if p.nic is null then raise exception 'Please complete your profile first'; end if;
  perform dq_finalize_expired();

  select * into a from dq_attempts where day = p_day and student_id = p.id;
  if not found then
    if p_day <> lk_today() then raise exception 'This quiz is closed. You can view the answers instead'; end if;
    select count(*) into n from dq_questions where day = p_day;
    if n = 0 then raise exception 'No questions for this day'; end if;
    insert into dq_attempts (day, student_id, deadline, perms)
    values (p_day, p.id, now() + make_interval(secs => n * 120),
            -- "where q.id is not null" ties the shuffle to each question, so every question gets its own order
            (select jsonb_object_agg(q.id, (select jsonb_agg(v order by random()) from generate_series(0, 4) v where q.id is not null))
               from dq_questions q where q.day = p_day))
    on conflict (day, student_id) do nothing;
    select * into a from dq_attempts where day = p_day and student_id = p.id;
  end if;

  if a.submitted_at is not null then
    return json_build_object('submitted', true);
  end if;

  return json_build_object(
    'submitted', false,
    'seconds_left', greatest(0, extract(epoch from a.deadline - now()))::int,
    'duration', extract(epoch from a.deadline - a.started_at)::int,
    'answers', a.answers,
    'title', (select title from dq_days where day = p_day),
    'questions', (
      select json_agg(json_build_object(
        'id', q.id, 'topic', q.topic, 'body', q.body, 'image_url', q.image_url,
        'options', (select json_agg(q.options[e.v::int + 1] order by e.ord)
                      from jsonb_array_elements_text(coalesce(a.perms -> q.id, '[0,1,2,3,4]'::jsonb))
                           with ordinality e(v, ord)),
        -- Sinhala / Tamil versions, shuffled the same way as the English options
        'tr', json_build_object(
          'si', json_build_object('body', q.body_si, 'options', dq_shuffled(q.options_si, a.perms -> q.id)),
          'ta', json_build_object('body', q.body_ta, 'options', dq_shuffled(q.options_ta, a.perms -> q.id)))
      ) order by q.position)
      from dq_questions q where q.day = p_day)
  );
end $$;

-- Autosave while answering (so nothing is lost if the phone dies).
create or replace function public.dq_save(p_day date, p_answers jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  update dq_attempts set answers = coalesce(p_answers, '{}'::jsonb)
   where day = p_day and student_id = auth.uid()
     and submitted_at is null and now() <= deadline + interval '5 seconds';
end $$;

-- Review of a day: my answers + correct answers + methods + my rank.
-- Allowed after I submit, or for anyone once the day is over.
create or replace function public.dq_review(p_day date, p_user uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := coalesce(p_user, auth.uid());
  a dq_attempts; has boolean; v_rank int; v_n int; v_avg numeric;
begin
  if auth.uid() is null then raise exception 'Please log in'; end if;
  if uid <> auth.uid() and not is_admin() then raise exception 'Not allowed'; end if;
  if p_day > lk_today() then raise exception 'Not released yet'; end if;
  perform dq_finalize_expired();

  select * into a from dq_attempts where day = p_day and student_id = uid;
  has := found and a.submitted_at is not null;
  if not has and p_day = lk_today() and not is_admin() then
    raise exception 'Finish today''s quiz to see the answers';
  end if;

  select count(*), avg(x.score::numeric / nullif(x.total, 0) * 100)
    into v_n, v_avg
  from dq_attempts x join profiles pr on pr.id = x.student_id
  where x.day = p_day and x.submitted_at is not null and not pr.is_banned and not pr.is_admin;

  if has then
    select count(*) + 1 into v_rank
    from dq_attempts x join profiles pr on pr.id = x.student_id
    where x.day = p_day and x.submitted_at is not null and not pr.is_banned and not pr.is_admin and x.id <> a.id
      and (x.score > a.score or (x.score = a.score and x.time_taken < a.time_taken));
  end if;

  return json_build_object(
    'day', p_day,
    'title', (select title from dq_days where day = p_day),
    'attempted', has,
    'score', case when has then a.score end,
    'total', (select count(*) from dq_questions where day = p_day),
    'time_taken', case when has then a.time_taken end,
    'duration', case when has then extract(epoch from a.deadline - a.started_at)::int end,
    'rank', v_rank, 'participants', v_n, 'avg_pct', round(v_avg, 1),
    'questions', (
      select json_agg(json_build_object(
        'id', q.id, 'topic', q.topic, 'body', q.body, 'image_url', q.image_url,
        'options', case when has
          then (select json_agg(q.options[e.v::int + 1] order by e.ord)
                  from jsonb_array_elements_text(coalesce(a.perms -> q.id, '[0,1,2,3,4]'::jsonb)) with ordinality e(v, ord))
          else to_json(q.options) end,
        'correct', case when has
          then (select (e.ord - 1)::int
                  from jsonb_array_elements_text(coalesce(a.perms -> q.id, '[0,1,2,3,4]'::jsonb)) with ordinality e(v, ord)
                 where e.v::int = k.correct_index)
          else k.correct_index end,
        'yours', case when has and jsonb_typeof(a.answers -> q.id) = 'number' then (a.answers ->> q.id)::int end,
        'explain', k.explanation,
        'tr', json_build_object(
          'si', json_build_object('body', q.body_si, 'explain', k.explanation_si,
                  'options', case when has then dq_shuffled(q.options_si, a.perms -> q.id) else to_json(q.options_si) end),
          'ta', json_build_object('body', q.body_ta, 'explain', k.explanation_ta,
                  'options', case when has then dq_shuffled(q.options_ta, a.perms -> q.id) else to_json(q.options_ta) end))
      ) order by q.position)
      from dq_questions q left join dq_keys k on k.question_id = q.id
      where q.day = p_day)
  );
end $$;

create or replace function public.dq_submit(p_day date, p_answers jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare a dq_attempts;
begin
  select * into a from dq_attempts where day = p_day and student_id = auth.uid() for update;
  if not found then raise exception 'Start the quiz first'; end if;
  if a.submitted_at is null then
    if now() <= a.deadline + interval '30 seconds' then
      update dq_attempts
         set answers = coalesce(p_answers, answers),
             submitted_at = least(now(), deadline),
             time_taken = extract(epoch from least(now(), deadline) - started_at)::int
       where id = a.id;
    else
      -- Too late: keep the last autosaved answers.
      update dq_attempts
         set submitted_at = deadline,
             time_taken = extract(epoch from deadline - started_at)::int
       where id = a.id;
    end if;
    perform dq_grade(a.id);
  end if;
  return dq_review(p_day);
end $$;

-- Leaderboard: correct answers ÷ all questions released in the period. Ties → lower average time.
create or replace function public.dq_leaderboard(p_period text) returns json
language plpgsql security definer set search_path = public as $$
declare t date := lk_today(); d0 date; total_q int; n_days int;
begin
  if auth.uid() is null then raise exception 'Please log in'; end if;
  perform dq_finalize_expired();
  d0 := case p_period when 'today' then t when 'week' then t - 6 when 'month' then t - 29
                      else date '2000-01-01' end;
  select count(*), count(distinct day) into total_q, n_days from dq_questions where day between d0 and t;

  return json_build_object(
    'period', p_period, 'from', d0, 'to', t,
    'total_questions', total_q, 'days', n_days,
    'rows', coalesce((
      select json_agg(r order by r.rank, r.name) from (
        select rank() over (order by sum(a.score) desc, avg(a.time_taken) asc)::int as rank,
               (p.id = auth.uid()) as me,
               p.full_name as name, p.school,
               sum(a.score)::int as correct,
               count(*)::int as quizzes,
               round(avg(a.time_taken))::int as avg_time,
               round(100.0 * sum(a.score) / nullif(total_q, 0), 1) as pct
        from dq_attempts a join profiles p on p.id = a.student_id
        where a.submitted_at is not null and a.day between d0 and t and not p.is_banned and not p.is_admin
        group by p.id, p.full_name, p.school
      ) r where r.rank <= 100 or r.me), '[]'::json)
  );
end $$;

-- My progress (the admin can pass any student's id).
create or replace function public.dq_stats(p_user uuid default null) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := coalesce(p_user, auth.uid()); t date := lk_today(); cur int; best int;
begin
  if auth.uid() is null then raise exception 'Please log in'; end if;
  if uid <> auth.uid() and not is_admin() then raise exception 'Not allowed'; end if;
  perform dq_finalize_expired();

  with d as (select day from dq_attempts where student_id = uid and submitted_at is not null),
       g as (select day, day - (row_number() over (order by day))::int as grp from d),
       isl as (select max(day) as e, count(*) as n from g group by grp)
  select coalesce(max(n) filter (where e >= t - 1), 0), coalesce(max(n), 0) into cur, best from isl;

  return json_build_object(
    'streak', cur, 'best_streak', best,
    'quizzes', (select count(*) from dq_attempts where student_id = uid and submitted_at is not null),
    'questions', (select coalesce(sum(total), 0) from dq_attempts where student_id = uid and submitted_at is not null),
    'answered', (select count(*) from dq_responses r join dq_attempts a on a.id = r.attempt_id
                  where a.student_id = uid and r.chosen is not null),
    'correct', (select count(*) from dq_responses r join dq_attempts a on a.id = r.attempt_id
                  where a.student_id = uid and r.is_correct),
    'avg_time', (select round(avg(time_taken))::int from dq_attempts where student_id = uid and submitted_at is not null),
    'days_released', (select count(distinct day) from dq_questions where day <= t),
    'history', coalesce((
      select json_agg(h order by h.day) from (
        select a.day, d.title, a.score, a.total, a.time_taken,
               (select count(*) + 1 from dq_attempts x join profiles pr on pr.id = x.student_id
                 where x.day = a.day and x.submitted_at is not null and not pr.is_banned and not pr.is_admin and x.id <> a.id
                   and (x.score > a.score or (x.score = a.score and x.time_taken < a.time_taken)))::int as rank,
               (select count(*) from dq_attempts x join profiles pr on pr.id = x.student_id
                 where x.day = a.day and x.submitted_at is not null and not pr.is_banned and not pr.is_admin)::int as participants,
               (select round(avg(x.score::numeric / nullif(x.total, 0) * 100), 1) from dq_attempts x join profiles pr on pr.id = x.student_id
                 where x.day = a.day and x.submitted_at is not null and not pr.is_banned and not pr.is_admin) as avg_pct
        from dq_attempts a join dq_days d on d.day = a.day
        where a.student_id = uid and a.submitted_at is not null
      ) h), '[]'::json),
    'topics', coalesce((
      select json_agg(tp order by tp.total desc) from (
        select q.topic, count(*)::int as total, count(*) filter (where r.is_correct)::int as correct
        from dq_responses r
        join dq_attempts a on a.id = r.attempt_id
        join dq_questions q on q.id = r.question_id
        where a.student_id = uid and q.topic <> ''
        group by q.topic
      ) tp), '[]'::json)
  );
end $$;

-- Students may update their own name / phone / school etc. (column grants come from the website schema).

-- ---------- Admin functions ----------
create or replace function public.dq_require_admin() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'Admins only';
  end if;
end $$;

create or replace function public.dq_admin_students() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  perform dq_finalize_expired();
  return coalesce((
    select json_agg(s order by s.created_at desc) from (
      select p.id, p.full_name, p.email, p.phone, p.school, p.district, p.exam_year, p.nic,
             p.is_banned, p.ban_reason, p.created_at,
             count(a.id) filter (where a.submitted_at is not null)::int as quizzes,
             coalesce(sum(a.score), 0)::int as correct,
             coalesce(sum(a.total), 0)::int as questions,
             max(a.day) as last_day
      from profiles p left join dq_attempts a on a.student_id = p.id
      where not p.is_admin
      group by p.id
    ) s), '[]'::json);
end $$;

create or replace function public.dq_admin_set_ban(p_user uuid, p_banned boolean, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  update profiles set is_banned = p_banned, ban_reason = coalesce(p_reason, '') where id = p_user;
end $$;

create or replace function public.dq_admin_set_nic(p_user uuid, p_nic text) returns text
language plpgsql security definer set search_path = public as $$
declare n text;
begin
  perform dq_require_admin();
  if coalesce(trim(p_nic), '') = '' then
    update profiles set nic = null where id = p_user;
    return null;
  end if;
  n := normalize_nic(p_nic);
  if n is null then raise exception 'That NIC number is not valid'; end if;
  if exists (select 1 from profiles where nic = n and id <> p_user) then
    raise exception 'That NIC belongs to another account';
  end if;
  update profiles set nic = n where id = p_user;
  return n;
end $$;

create or replace function public.dq_admin_days() returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  perform dq_finalize_expired();
  return coalesce((
    select json_agg(x order by x.day desc) from (
      select d.day, d.title,
             (select count(*) from dq_questions q where q.day = d.day)::int as count,
             (select count(*) from dq_attempts a where a.day = d.day and a.submitted_at is not null)::int as participants,
             (select round(avg(a.score::numeric / nullif(a.total, 0) * 100), 1) from dq_attempts a
               where a.day = d.day and a.submitted_at is not null) as avg_pct
      from dq_days d
    ) x), '[]'::json);
end $$;

-- Rank sheet + question analysis for one day.
create or replace function public.dq_admin_day(p_day date) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  perform dq_finalize_expired();
  return json_build_object(
    'day', p_day,
    'title', (select title from dq_days where day = p_day),
    'rows', coalesce((
      select json_agg(r order by r.rank, r.name) from (
        select rank() over (order by a.score desc, a.time_taken asc)::int as rank,
               a.id as attempt_id, p.id as student_id, p.full_name as name, p.school, p.nic, p.phone,
               p.is_banned, a.score, a.total, a.time_taken, a.submitted_at
        from dq_attempts a join profiles p on p.id = a.student_id
        where a.day = p_day and a.submitted_at is not null
      ) r), '[]'::json),
    'in_progress', (select count(*) from dq_attempts where day = p_day and submitted_at is null),
    'questions', coalesce((
      select json_agg(json_build_object(
        'id', q.id, 'topic', q.topic, 'body', q.body, 'options', q.options,
        'correct', k.correct_index,
        'counts', (select json_agg((select count(*) from dq_responses r where r.question_id = q.id and r.chosen = i)) from generate_series(0, 4) i),
        'skipped', (select count(*) from dq_responses r where r.question_id = q.id and r.chosen is null)
      ) order by q.position)
      from dq_questions q left join dq_keys k on k.question_id = q.id
      where q.day = p_day), '[]'::json)
  );
end $$;

create or replace function public.dq_admin_reset(p_attempt uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  delete from dq_attempts where id = p_attempt;
end $$;

-- Used by the publish tool after fixing a question: re-mark everyone for that day.
create or replace function public.dq_regrade_day(p_day date) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  perform dq_require_admin();
  for r in select id from dq_attempts where day = p_day and submitted_at is not null loop
    perform dq_grade(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Only logged-in users may call these (anon gets nothing).
revoke execute on function public.dq_grade(uuid) from public, anon, authenticated;
revoke execute on function public.dq_finalize_expired() from public, anon;

-- ---------- Report a mistake ----------
create table if not exists public.dq_reports (
  id          uuid primary key default gen_random_uuid(),
  question_id text not null references public.dq_questions(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  reason      text not null default '',
  message     text not null default '',
  status      text not null default 'open' check (status in ('open', 'fixed', 'dismissed')),
  created_at  timestamptz not null default now(),
  unique (question_id, student_id)
);
alter table public.dq_reports enable row level security;
drop policy if exists "dq_reports admin" on public.dq_reports;
create policy "dq_reports admin" on public.dq_reports for select using (public.is_admin());

-- A student reports a question (only after submitting that day's quiz, or once the day is over).
create or replace function public.dq_report(p_question text, p_reason text, p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare p profiles; d date;
begin
  p := dq_me();
  if p.is_banned then raise exception 'Your account has been suspended'; end if;
  select day into d from dq_questions where id = p_question;
  if not found then raise exception 'Question not found'; end if;
  if d >= lk_today() and not exists (
       select 1 from dq_attempts where day = d and student_id = p.id and submitted_at is not null) then
    raise exception 'You can report a question after submitting the quiz';
  end if;
  insert into dq_reports (question_id, student_id, reason, message)
  values (p_question, p.id, left(coalesce(p_reason, ''), 40), left(coalesce(p_message, ''), 500))
  on conflict (question_id, student_id) do update
    set reason = excluded.reason, message = excluded.message, status = 'open', created_at = now();
end $$;

create or replace function public.dq_admin_reports(p_status text default 'open') returns json
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  return coalesce((
    select json_agg(x order by x.created_at desc) from (
      select r.id, r.question_id, r.reason, r.message, r.status, r.created_at,
             q.day, q.position, q.body, q.options, k.correct_index, d.title,
             p.full_name, p.school
      from dq_reports r
      join dq_questions q on q.id = r.question_id
      join dq_days d on d.day = q.day
      left join dq_keys k on k.question_id = q.id
      join profiles p on p.id = r.student_id
      where r.status = p_status
      order by r.created_at desc
      limit 300
    ) x), '[]'::json);
end $$;

create or replace function public.dq_admin_set_report(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform dq_require_admin();
  if p_status not in ('open', 'fixed', 'dismissed') then raise exception 'Bad status'; end if;
  update dq_reports set status = p_status where id = p_id;
end $$;

-- ---------- Schedule health (for the empty-day alert) ----------
create or replace function public.dq_admin_status() returns json
language plpgsql security definer set search_path = public as $$
declare t date := lk_today();
begin
  perform dq_require_admin();
  return json_build_object(
    'today', t,
    'today_count', (select count(*) from dq_questions where day = t),
    'tomorrow_count', (select count(*) from dq_questions where day = t + 1),
    'days_ahead', (select count(distinct day) from dq_questions where day > t),
    'next_empty_day', (select min(g::date) from generate_series(t + 1, t + 90, interval '1 day') g
                        where not exists (select 1 from dq_questions q where q.day = g::date)),
    'open_reports', (select count(*) from dq_reports where status = 'open')
  );
end $$;
