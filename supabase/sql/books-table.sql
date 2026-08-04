-- New table for the book-scanning/library feature. Separate from
-- public.entries.book (which stays exactly as-is, plain text, unchanged) --
-- this is an additive convenience layer: a real list of books the reader has
-- scanned, with an ISBN and a title/author that fills the existing "Reading"
-- text field when picked, not a replacement for it.
--
-- RLS follows the SAME per-row-ownership shape public.entries already uses
-- (auth.uid() = user_id) -- NOT the admin-allowed-emails pattern, which
-- hardcodes one specific admin UID and is the wrong model for a per-user
-- personal list like this one.
--
-- unique(user_id, isbn) lets saveBook() upsert on re-scanning the same book
-- instead of creating a duplicate row. isbn is nullable (a manual title/author
-- entry, with no photo, has nothing to dedupe on) -- Postgres treats multiple
-- NULLs as distinct for a unique constraint, so manual entries never collide
-- with each other or with a real ISBN.

create table public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id),
  isbn text,
  title text not null,
  author text,
  added_at timestamptz not null default now(),
  unique (user_id, isbn)
);

alter table public.books enable row level security;

create policy "select own books" on public.books
  for select using (auth.uid() = user_id);

create policy "insert own books" on public.books
  for insert with check (auth.uid() = user_id);

create policy "delete own books" on public.books
  for delete using (auth.uid() = user_id);
