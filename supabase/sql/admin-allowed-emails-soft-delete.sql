-- Extends allowed_emails for the admin UI: an activity log (when each email
-- was added / removed) and soft-delete (so removed emails stay visible,
-- greyed out, instead of disappearing). Run after admin-allowed-emails-rls.sql.
-- Replace YOUR-UID-HERE with the same admin UID used there.

-- 1. Track when each row was added, and (if applicable) soft-deleted.
--    Existing rows will show "added" as whenever this migration runs, since
--    the original add time was never tracked before now -- a known gap in
--    the history, not a bug.
alter table public.allowed_emails
  add column if not exists added_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

-- 2. The admin now needs UPDATE too -- "deleting" a row sets deleted_at
--    instead of removing it, and re-adding a previously-deleted email
--    revives it (clears deleted_at) via the same upsert path.
create policy "admin_update_allowed_emails"
on public.allowed_emails
for update
to authenticated
using (auth.uid() = 'YOUR-UID-HERE'::uuid)
with check (auth.uid() = 'YOUR-UID-HERE'::uuid);

-- 3. Without this, a soft-deleted row would still satisfy the original
--    "exists" check below and let that email sign in anyway -- the admin
--    UI's "Delete" would be cosmetic, not a real revocation. This is the
--    live check_allowed_email() definition (confirmed 2026-07-31) with
--    exactly one clause added: "and deleted_at is null". Everything else
--    (SECURITY DEFINER, search_path, the lower() normalization, the
--    exception message) is unchanged. CREATE OR REPLACE keeps the same
--    function identity, so the existing "before insert on auth.users"
--    trigger picks up this new logic immediately -- no need to touch the
--    trigger itself.
CREATE OR REPLACE FUNCTION public.check_allowed_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from public.allowed_emails
    where email = lower(new.email)
      and deleted_at is null
  ) then
    raise exception 'signup rejected: % is not on the invite list', new.email;
  end if;
  return new;
end;
$function$;
