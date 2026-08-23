-- Feature-usage counters, 2026-08-23.
--
-- Extends lookup-stats.sql's allowlist so the admin page can answer a
-- different question from "is the dictionary healthy?": which parts of the app
-- people actually reach for, and which ones nobody has ever touched. A feature
-- with real use is worth improving; one with none is worth either explaining
-- better or removing, and today there is no way to tell those apart.
--
-- Postgres has no "add a value to a check constraint", so the constraint is
-- replaced wholesale and every existing value has to be carried forward --
-- including 'ai_lookup', which the client no longer writes (it was split into
-- ai_auto/ai_viewed below). Dropping it here would make the constraint fail to
-- validate against the rows already in the table.
--
-- COUNTS ONLY, NEVER THE CONTENT. Same rule as the original table and the same
-- test: every key below records THAT something was used, never what it was used
-- on. No word, sentence, book title, photo or email goes anywhere near this.

alter table public.lookup_stats
  drop constraint if exists lookup_stats_outcome_known;

alter table public.lookup_stats
  add constraint lookup_stats_outcome_known check (outcome in (
    -- ---- dictionary health (lookup-stats.sql) ----
    'ok',            -- a definition came back
    'not_found',     -- reachable, word genuinely absent from both sources
    'server_error',  -- 5xx, or a 200 whose body wasn't usable. Their end.
    'network_error', -- never got an answer, and the browser thought it was online
    'offline',       -- never got an answer, and the browser knew why
    'retried',       -- a 5xx/reset that the one retry then rescued
    'audio_ok',      -- the API's pronunciation file played
    'audio_failed',  -- it didn't, and the synthesised voice stood in

    -- ---- the two-source fallback (2026-08-23) ----
    -- backup_ok is the number that says how much the second dictionary is
    -- earning its place. If it stays at zero the primary is healthy again; if
    -- it carries a large share of lookups, the primary should be demoted.
    'backup_ok',     -- the primary failed and the backup answered
    'backup_failed', -- both sources failed

    -- ---- retired, kept so the constraint validates against old rows ----
    'ai_lookup',     -- pre-2026-08-23: every AI definition, however triggered

    -- ---- how the app is used ----
    'app_open',      -- a signed-in session started
    'ai_auto',       -- an AI definition was generated automatically (prefetch)
    'ai_viewed',     -- someone actually opened the AI tab and read one
    'voice_input',   -- something was said to the mic and recognised
    'scan_used',     -- a page region was sent to be read
    'ocr_word_tap',  -- a word was tapped on a scanned page
    'save_dict',     -- saved from the dictionary tab (single sense)
    'save_meaning',  -- saved one specific meaning from a multi-sense card
    'save_ai',       -- saved from the AI tab
    'save_queued',   -- "Save for later" while unreachable
    'sentence_added',-- a save carried the reader's own line from the book
    'word_deleted',
    'learned_marked',-- a saved word was flagged as learned
    'practice_flash',
    'practice_quiz',
    'book_scan',     -- a book cover was scanned
    'book_manual',   -- a book was typed in by hand instead
    'library_pick',  -- a book was chosen from the library dropdown
    'faq_open',
    'feedback_sent',
    'install_click'  -- the in-app Install button was used
  ));

-- The function's own allowlist has to match. Both copies are deliberate: the
-- constraint stops a bad row however it arrives, the array stops a mistyped
-- key from silently splitting a total in two.
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
    'backup_ok', 'backup_failed',
    'app_open', 'ai_auto', 'ai_viewed', 'voice_input', 'scan_used',
    'ocr_word_tap', 'save_dict', 'save_meaning', 'save_ai', 'save_queued',
    'sentence_added', 'word_deleted', 'learned_marked',
    'practice_flash', 'practice_quiz',
    'book_scan', 'book_manual', 'library_pick',
    'faq_open', 'feedback_sent', 'install_click'
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
    continue when not (entry.key = any (known));
    continue when jsonb_typeof(entry.value) <> 'number';

    n := (entry.value #>> '{}')::numeric::integer;
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
