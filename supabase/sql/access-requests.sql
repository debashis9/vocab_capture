-- The queue behind the "ask for access" form on the sign-in card: a stranger
-- who taps a shared link can put their email in front of the admin instead of
-- hitting a dead end. Anyone may add themselves (through the one narrow
-- function at the bottom); only the admin may read the queue or act on it.
--
-- Run once in the Supabase SQL Editor, after admin-allowed-emails-soft-delete.sql.
-- Safe to re-run: every statement is idempotent.
--
-- The admin UID is written out below rather than left as the YOUR-UID-HERE
-- placeholder the two admin-allowed-emails-*.sql files use -- it's the same
-- value those two already have applied, it's the same one hardcoded as
-- ADMIN_USER_ID in index.html, and it's confirmed against the live project. To
-- check it yourself:
--   select id from auth.users where email = 'debashis9@gmail.com';

-- 1. The queue itself. `note` is whatever the requester typed into "how do I
--    know you?" -- the thing that makes an otherwise anonymous gmail address
--    actually decidable.
create table if not exists public.access_requests (
  id                bigint generated always as identity primary key,
  email             text        not null,
  display_name      text,
  note              text,
  status            text        not null default 'pending'
                    check (status in ('pending', 'approved', 'denied')),
  requested_at      timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  request_count     integer     not null default 1,
  decided_at        timestamptz,
  decided_by        uuid
);

-- One row per person no matter how many times they ask. request_count carries
-- the "they've now asked three times" signal instead of three duplicate rows.
create unique index if not exists access_requests_email_key
  on public.access_requests (lower(email));

alter table public.access_requests enable row level security;

-- 2. Only the admin may read the queue. Note there is deliberately NO insert
--    policy for anon or authenticated: the only write path is request_access()
--    below, which is SECURITY DEFINER and so runs as the table owner, for whom
--    RLS doesn't apply. That keeps the public surface down to one function with
--    validation and a rate limit inside it, rather than an open table.
drop policy if exists "admin_select_access_requests" on public.access_requests;
create policy "admin_select_access_requests"
on public.access_requests
for select
to authenticated
using (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);

-- 3. Approve / ignore both land here as an UPDATE of status.
drop policy if exists "admin_update_access_requests" on public.access_requests;
create policy "admin_update_access_requests"
on public.access_requests
for update
to authenticated
using (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid)
with check (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);

-- 4. The one public entry point. Callable by anon (that's the whole point --
--    the person calling it has never had an account), and answering with a
--    flat 'received' in every ordinary case: pending, repeat, already-invited,
--    previously-ignored. That neutrality is deliberate. A distinct
--    "you're already on the list" reply would turn this form into a way for a
--    stranger to test whether any given address is a Margin user, and a
--    distinct "you were denied" reply would make ignoring someone an
--    announcement rather than a quiet no.
create or replace function public.request_access(
  p_email text,
  p_name  text default null,
  p_note  text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_email  text := lower(trim(p_email));
  v_id     bigint;
  v_recent integer;
begin
  -- Character allowlist rather than "anything without an @ or a space". The
  -- admin page escapes all three of these fields on render, so this isn't what
  -- stops an injected payload -- but an address that can't contain <, > or a
  -- quote in the first place is one less thing depending on that being right
  -- forever.
  if v_email is null or v_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    return 'invalid';
  end if;

  -- Nothing here is free-form prose, and this function is callable by anyone
  -- with the public anon key. Without a ceiling a single caller could park
  -- megabytes in the table and wreck the admin list's layout on the way past.
  -- 254 is RFC 5321's practical maximum for an address; the other two are just
  -- generous versions of what the form's own maxlength allows.
  if length(v_email) > 254
     or length(coalesce(p_name, '')) > 80
     or length(coalesce(p_note, '')) > 280 then
    return 'invalid';
  end if;

  -- Already invited, so there's nothing to queue. They should just use the
  -- normal sign-in box.
  if exists (
    select 1 from allowed_emails
    where email = v_email and deleted_at is null
  ) then
    return 'received';
  end if;

  select id into v_id from access_requests where lower(email) = v_email;
  if found then
    update access_requests
       set request_count     = request_count + 1,
           last_requested_at = now(),
           -- Only ever fill in a blank; a later empty submission shouldn't
           -- wipe out the name they gave the first time.
           display_name      = coalesce(nullif(trim(p_name), ''), display_name),
           note              = coalesce(nullif(trim(p_note), ''), note)
     -- At most one bump a minute. The rate limit further down only counts
     -- *new* rows, so without this clause the repeat path is an unmetered
     -- write: once an address is in the table, the same caller could hammer
     -- this function forever and every call would do a real update. Matching
     -- nothing is fine -- the answer below is the same either way, which is
     -- also what stops the timing of it from revealing anything.
     where id = v_id
       and last_requested_at < now() - interval '1 minute';
    return 'received';
  end if;

  -- Flood guard. The anon key is embedded in a public page, so this function is
  -- callable by anyone who views source; without a ceiling a bored stranger
  -- could fill the table. Twenty *new* people an hour sits far above any real
  -- friends-and-family rate and far below a nuisance.
  select count(*) into v_recent
    from access_requests
   where requested_at > now() - interval '1 hour';

  if v_recent >= 20 then
    return 'rate_limited';
  end if;

  insert into access_requests (email, display_name, note)
  values (v_email, nullif(trim(p_name), ''), nullif(trim(p_note), ''));

  return 'received';
end;
$function$;

revoke all on function public.request_access(text, text, text) from public;
grant execute on function public.request_access(text, text, text) to anon, authenticated;
