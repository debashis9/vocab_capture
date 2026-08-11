-- Health telemetry for the outbound lookup calls.
--
-- Run once in the Supabase SQL Editor. Safe to re-run: every statement is
-- idempotent.
--
-- Why this exists. On 2026-08-11 two complaints arrived together -- "lookups
-- often error or say not found" and "pronunciation has been dead for days" --
-- and answering either one meant curling dictionaryapi.dev by hand to discover
-- that their CDN serves cached entries fine while anything reaching their
-- origin returns 502/500 (~40% of not-found lookups, ~70% of pronunciation
-- files). Nothing in the app knew that. Every one of those failures was caught
-- and turned into a polite message, so it left no trace anywhere.
--
-- This is deliberately NOT crash reporting (see CLAUDE.md's Sentry note). A
-- crash reporter watches for your own code throwing; the failure mode here is
-- a third party answering correctly-formed HTTP errors, which is invisible to
-- one. What's wanted is a success rate.
--
-- COUNTS ONLY, NEVER THE WORD. A row says "11 lookups succeeded today", not
-- which words were looked up. Saved words are already stored deliberately by
-- the person saving them; a log of everything typed into the box, including
-- what was typed and abandoned, is a different and more intrusive thing. The
-- app's privacy list in guide.html therefore needs no new entry, which is the
-- test this design was held to.

create table if not exists public.lookup_stats (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  -- Bucketed by day rather than a row per event. A few testers on auto-search
  -- (which fires on every 500ms typing pause) would otherwise write thousands
  -- of rows a week to answer a question that needs five numbers.
  day        date        not null default current_date,
  outcome    text        not null,
  count      integer     not null default 0,
  updated_at timestamptz not null default now(),

  primary key (user_id, day, outcome),

  -- The allowlist lives here as well as in the function below, so a future
  -- second caller can't quietly invent a category and split the totals.
  constraint lookup_stats_outcome_known check (outcome in (
    'ok',            -- a definition came back
    'not_found',     -- a real 404: reachable, word genuinely absent
    'server_error',  -- 5xx, or a 200 whose body wasn't usable. Their end.
    'network_error', -- never got an answer, and the browser thought it was online
    'offline',       -- never got an answer, and the browser knew why
    'retried',       -- a 5xx that the one retry then rescued. See note below.
    'audio_ok',      -- the API's pronunciation file played
    'audio_failed'   -- it didn't, and the synthesised voice stood in
  )),
  constraint lookup_stats_count_sane check (count >= 0)
);

-- 'retried' is the most valuable number here and the easiest to lose. A 5xx
-- that the retry rescues is reported to the user as a clean success, so
-- without counting it the outage becomes invisible again the moment the retry
-- papers over it -- which is exactly the failure this whole table exists to
-- stop. It is a count of lookups that needed a second attempt, so it overlaps
-- 'ok' and 'server_error' rather than partitioning with them.

create index if not exists lookup_stats_day_idx
  on public.lookup_stats (day desc);

alter table public.lookup_stats enable row level security;

-- Only the admin may read it, and there is no policy for anything else:
-- writes go exclusively through record_lookup_outcomes below, which is
-- SECURITY DEFINER and so bypasses RLS. Same hardcoded UID as every other
-- admin policy in this project (index.html's ADMIN_USER_ID, feedback.sql).
--
-- Note this means a tester's own numbers aren't readable by that tester. Same
-- shape as feedback: they contribute to it, they don't consult it.
drop policy if exists "admin_select_lookup_stats" on public.lookup_stats;
create policy "admin_select_lookup_stats"
on public.lookup_stats
for select
to authenticated
using (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);

-- The only writer. Takes a whole batch as {"ok": 3, "retried": 1} because the
-- client buffers and flushes rather than calling once per lookup -- telemetry
-- must not add a network round trip to the thing it's measuring.
--
-- SECURITY DEFINER with its own auth.uid() read, following set_email_access:
-- identity comes from the verified session, never from an argument, so a
-- caller cannot write into someone else's totals.
create or replace function public.record_lookup_outcomes(counts jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  known  text[] := array[
    'ok', 'not_found', 'server_error', 'network_error',
    'offline', 'retried', 'audio_ok', 'audio_failed'
  ];
  entry  record;
  n      integer;
begin
  if uid is null then
    return; -- signed out: nothing to attribute it to, so drop it silently
  end if;

  if counts is null or jsonb_typeof(counts) <> 'object' then
    return;
  end if;

  for entry in select key, value from jsonb_each(counts) loop
    -- Skip anything unrecognised or unreasonable rather than raising. This is
    -- fire-and-forget from the client's point of view: a rejection would be
    -- neither seen nor retried, so being strict about one bad key would only
    -- throw away the good ones beside it.
    continue when not (entry.key = any (known));
    continue when jsonb_typeof(entry.value) <> 'number';

    n := (entry.value #>> '{}')::numeric::integer;

    -- The per-call ceiling is the same reasoning as access_requests' length
    -- caps: a valid session is still an untrusted caller, and an unbounded
    -- increment is an unbounded lie in the only numbers being trusted here.
    continue when n is null or n <= 0 or n > 5000;

    insert into public.lookup_stats (user_id, day, outcome, count)
    values (uid, current_date, entry.key, n)
    on conflict (user_id, day, outcome) do update
      set count = lookup_stats.count + excluded.count,
          updated_at = now();
  end loop;
end;
$$;

revoke all on function public.record_lookup_outcomes(jsonb) from public, anon;
grant execute on function public.record_lookup_outcomes(jsonb) to authenticated;
