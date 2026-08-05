-- Invite codes: a link you send personally that lets someone in without
-- waiting for you. `.../?i=fam2026` -- they put their email in, get their
-- sign-in link straight away, and never touch the approval queue.
--
-- This is the answer to "seamless onboarding" that the queue isn't: the queue
-- makes you a faster bottleneck, a code takes you out of the path. The queue
-- stays as the fallback for anyone who lost the code or got a forwarded bare
-- link, which is rare and never urgent.
--
-- Run once in the Supabase SQL Editor, after access-requests.sql.
-- Safe to re-run: every statement is idempotent.

-- 1. The codes themselves. All four knobs are yours to set per code:
--      code        what people type / what goes in the link
--      label       a note to yourself about who you gave it to
--      max_uses    null = unlimited (see the warning on that below)
--      expires_at  null = never
--    Codes are stored in the clear on purpose -- you have to be able to read
--    one back to put it in a WhatsApp message. They're bearer secrets with a
--    small blast radius (a leaked code can add strangers to the invite list,
--    capped by max_uses, and you can disable it), not passwords.
create table if not exists public.invite_codes (
  code        text primary key,
  label       text,
  max_uses    integer,
  uses        integer     not null default 0,
  expires_at  timestamptz,
  disabled_at timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

alter table public.invite_codes enable row level security;

-- Only the admin touches this table directly. Redemption happens through
-- claim_invite_code() below, which runs as the table owner.
drop policy if exists "admin_select_invite_codes" on public.invite_codes;
create policy "admin_select_invite_codes"
on public.invite_codes for select to authenticated
using (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);

drop policy if exists "admin_insert_invite_codes" on public.invite_codes;
create policy "admin_insert_invite_codes"
on public.invite_codes for insert to authenticated
with check (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);

drop policy if exists "admin_update_invite_codes" on public.invite_codes;
create policy "admin_update_invite_codes"
on public.invite_codes for update to authenticated
using (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid)
with check (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);

-- 2. So the queue doubles as a record of how each person actually got in,
--    rather than code redemptions being invisible.
alter table public.access_requests
  add column if not exists via_code text;

-- 3. Claiming a code. NOT granted to anon: only the redeem-invite Edge
--    Function calls this, using the service-role key. That's deliberate --
--    claiming has to be followed by creating the person's auth.users row and
--    mailing them, which the browser can't do, so there's no reason to expose
--    a half-step that leaves them on the invite list with no way in.
create or replace function public.claim_invite_code(
  p_code  text,
  p_email text,
  p_name  text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_code   text := lower(trim(p_code));
  v_email  text := lower(trim(p_email));
  v_row    public.invite_codes;
  v_recent integer;
begin
  if v_email is null or v_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
     or length(v_email) > 254
     or length(coalesce(p_name, '')) > 80 then
    return 'invalid_email';
  end if;

  -- FOR UPDATE is what makes max_uses a real cap rather than a suggestion:
  -- without the row lock, two people redeeming the last use at the same moment
  -- would both read uses = max_uses - 1 and both get in.
  select * into v_row from invite_codes where code = v_code for update;

  -- Every "this code is no good" answer is the same string. A code that
  -- reported "expired" separately from "no such code" would let someone
  -- with a guess confirm they'd found a real one.
  if not found
     or v_row.disabled_at is not null
     or (v_row.expires_at is not null and v_row.expires_at <= now())
     or (v_row.max_uses is not null and v_row.uses >= v_row.max_uses) then
    return 'invalid_code';
  end if;

  -- Already on the list: let them straight through to the sign-in box, and
  -- don't spend one of the code's uses on someone who didn't need it.
  if exists (
    select 1 from allowed_emails where email = v_email and deleted_at is null
  ) then
    return 'already_allowed';
  end if;

  -- A backstop for the case where max_uses is left unlimited. This endpoint
  -- creates accounts and sends real email, so a leaked unlimited code would
  -- otherwise be a spam relay with your Gmail account's name on it. Thirty an
  -- hour across all codes is far above any real gathering of family.
  select count(*) into v_recent
    from access_requests
   where via_code is not null
     and requested_at > now() - interval '1 hour';
  if v_recent >= 30 then
    return 'rate_limited';
  end if;

  update invite_codes set uses = uses + 1 where code = v_code;

  insert into allowed_emails (email, deleted_at)
  values (v_email, null)
  on conflict (email) do update set deleted_at = null;

  -- Recorded as an already-approved request, so the admin page shows how each
  -- person arrived without needing a second screen for it.
  insert into access_requests (email, display_name, status, decided_at, via_code)
  values (v_email, nullif(trim(p_name), ''), 'approved', now(), v_code)
  on conflict (lower(email)) do update
    set status       = 'approved',
        decided_at   = now(),
        via_code     = excluded.via_code,
        display_name = coalesce(access_requests.display_name, excluded.display_name);

  return 'ok';
end;
$function$;

revoke all on function public.claim_invite_code(text, text, text) from public;
