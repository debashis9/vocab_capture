-- Adds three feature-use counters to the lookup health table.
--
-- Run once in the Supabase SQL Editor (or via the MCP). Safe to re-run.
--
-- Why. The card in #admin answered "is the dictionary flaky today?" well, but
-- it could not answer "is anyone actually using the parts of this app that
-- took the longest to build?" -- the AI tab, voice input and page scanning
-- were all invisible. It also had no headcount: 40 lookups from one person
-- and 40 from four people are very different days, and the table showed them
-- identically. The headcount needs no schema change at all, since user_id is
-- already the first column of the primary key; only the three counters do.
--
-- COUNTS ONLY, NEVER THE WORD -- the same rule the original table was held to,
-- and the reason guide.html's privacy list still needs no new entry. These
-- record THAT the AI tab was opened, that something was said to the mic, that
-- a page was scanned. They do not record the word, the sentence, the book or
-- the photo.

-- Postgres has no "add a value to a check constraint", so the constraint is
-- replaced wholesale. Dropping and adding in one ALTER means the table is
-- never briefly unconstrained.
alter table public.lookup_stats
  drop constraint if exists lookup_stats_outcome_known,
  add constraint lookup_stats_outcome_known check (outcome in (
    'ok',            -- a definition came back
    'not_found',     -- a real 404: reachable, word genuinely absent
    'server_error',  -- 5xx, or a 200 whose body wasn't usable. Their end.
    'network_error', -- never got an answer, and the browser thought it was online
    'offline',       -- never got an answer, and the browser knew why
    'retried',       -- a 5xx that the one retry then rescued
    'audio_ok',      -- the API's pronunciation file played
    'audio_failed',  -- it didn't, and the synthesised voice stood in
    -- Feature use, below. These are NOT dictionary calls and are deliberately
    -- excluded from the "Lookups" total in the admin card -- folding them in
    -- would make the success rate beside them meaningless.
    'ai_lookup',     -- an AI-tab definition was generated for a word
    'voice_input',   -- the mic returned a word
    'scan_used'      -- a page region was sent to be read
  ));

-- Same allowlist again inside the only writer. Both copies are deliberate:
-- the constraint stops a bad row however it arrives, the array stops the
-- function silently splitting a total across a mistyped key.
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
    'offline', 'retried', 'audio_ok', 'audio_failed',
    'ai_lookup', 'voice_input', 'scan_used'
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
