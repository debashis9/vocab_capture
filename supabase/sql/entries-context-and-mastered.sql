-- Adds two optional columns to public.entries:
--   context_sentence: the sentence from the reader's own book where the word
--     was found (distinct from `example`, which is the dictionary/AI's own
--     generic example sentence).
--   mastered_at: null while still learning, a timestamp once marked mastered.
--     Same soft-flag pattern as allowed_emails.deleted_at -- doubles as both
--     a flag and a record of when.
-- No RLS changes needed: entries' existing policies already scope every
-- select/insert/update/delete to auth.uid(), so these new columns inherit
-- the same protection automatically.

alter table public.entries
  add column if not exists context_sentence text,
  add column if not exists mastered_at timestamptz;
