-- Admin-only access to public.allowed_emails, for the private #admin invite-list
-- UI in index.html. Run this once in the Supabase SQL Editor.
--
-- Replace every YOUR-UID-HERE below with your real Supabase user UID:
--   select id from auth.users where email = 'debashis9@gmail.com';

-- 1. Make sure `email` is unique -- needed so the admin UI's "add" can use
--    ON CONFLICT DO NOTHING instead of showing a duplicate-email error.
--    Safe to run even if a unique/primary-key constraint already exists on
--    this column (does nothing in that case).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.allowed_emails'::regclass
      and contype in ('p', 'u')
  ) then
    alter table public.allowed_emails add constraint allowed_emails_email_key unique (email);
  end if;
end $$;

-- 2. Only the admin account may read the list.
create policy "admin_select_allowed_emails"
on public.allowed_emails
for select
to authenticated
using (auth.uid() = 'YOUR-UID-HERE'::uuid);

-- 3. Only the admin account may add an email.
create policy "admin_insert_allowed_emails"
on public.allowed_emails
for insert
to authenticated
with check (auth.uid() = 'YOUR-UID-HERE'::uuid);

-- 4. Only the admin account may remove an email.
create policy "admin_delete_allowed_emails"
on public.allowed_emails
for delete
to authenticated
using (auth.uid() = 'YOUR-UID-HERE'::uuid);
