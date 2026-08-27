-- lookup-stats-timeout.sql -- 2026-08-27
--
-- Adds one counter: 'dict_timeout'.
--
-- Why it earns a migration. On 2026-08-27 api.dictionaryapi.dev stopped
-- failing fast (502 in ~250ms) and started failing SLOW (522 after ~19.5s,
-- Cloudflare sitting on its full connect timeout). Every existing bucket
-- reported that correctly and uselessly: the 522 carries no CORS header, so
-- the browser rejected the fetch and it landed in 'network_error' -- the same
-- bucket as a dead wifi connection. Nothing on the health card could tell
-- "their origin is hanging" apart from "this reader has no signal", which is
-- exactly the distinction that took a session to establish by hand.
--
-- 'dict_timeout' means: we set a deadline, and it expired. It is always the
-- service's fault and never the reader's, and it is the one bucket that says
-- the app is being held up rather than turned away.
--
-- Additive and safe to run while the old client is live: the existing rows and
-- the other keys are untouched, and record_lookup_outcomes skips unrecognised
-- keys rather than raising, so client-before-migration just reads zero.

alter table public.lookup_stats
  drop constraint if exists lookup_stats_outcome_known;

alter table public.lookup_stats
  add constraint lookup_stats_outcome_known check (outcome in (
    -- ---- dictionary health ----
    'ok', 'not_found', 'server_error', 'network_error', 'offline', 'retried',
    'dict_timeout',  -- NEW 2026-08-27: a source blew its deadline
    'audio_ok', 'audio_failed',

    -- ---- the two-source fallback (role-based; order swapped 2026-08-27) ----
    'backup_ok', 'backup_failed',

    -- ---- retired, kept so the constraint validates against old rows ----
    'ai_lookup',

    -- ---- how the app is used ----
    'app_open', 'ai_auto', 'ai_viewed', 'voice_input', 'scan_used',
    'ocr_word_tap', 'save_dict', 'save_meaning', 'save_ai', 'save_queued',
    'sentence_added', 'word_deleted', 'learned_marked',
    'practice_flash', 'practice_quiz',
    'book_scan', 'book_manual', 'library_pick',
    'faq_open', 'feedback_sent', 'install_click'
  ));

-- The writer's own allowlist. Deliberately a second copy of the same list:
-- the constraint stops a bad row however it arrives, this stops a mistyped key
-- silently splitting a total.
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
    'offline', 'retried', 'dict_timeout', 'audio_ok', 'audio_failed',
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

    n := (entry.value)::text::numeric::integer;
    continue when n is null or n <= 0 or n > 5000;

    insert into public.lookup_stats (user_id, day, outcome, count, updated_at)
    values (uid, current_date, entry.key, n, now())
    on conflict (user_id, day, outcome) do update
      set count = public.lookup_stats.count + excluded.count,
          updated_at = now();
  end loop;
end;
$$;
