-- Makes "Delete" on the invite list a real revocation.
--
-- The gap this closes: check_allowed_email() is a `before insert on auth.users`
-- trigger, so it runs exactly once, when an account is created. Soft-deleting
-- someone from allowed_emails therefore stopped a *new* account being made with
-- that address and nothing more -- anyone who had already signed in kept their
-- account, kept getting magic links, and kept their data. Delete was only ever
-- a real revocation for someone who had never signed in, which is precisely the
-- case it was tested against on 2026-07-31.
--
-- The fix uses banned_until, which is GoTrue's own field: it refuses to issue
-- tokens for a banned user. Deliberately NOT a trigger on auth.sessions, which
-- would also work and would be a much worse idea -- raising exceptions inside
-- GoTrue's internal tables is the kind of thing that breaks on a GoTrue upgrade
-- and produces an opaque 500 for the person signing in.
--
-- Run once in the Supabase SQL Editor, after access-requests.sql.
-- Safe to re-run.

-- Both directions in one function, because they have to stay in step: revoking
-- has to soft-delete AND ban, restoring has to revive AND unban. Splitting them
-- across the admin page's "Add" box and its "Delete" button (which is where
-- they lived) is what let the two drift apart in the first place.
--
-- SECURITY DEFINER so it can write to auth.users, with its own auth.uid() check
-- rather than an RLS policy -- a function that reaches into the auth schema
-- shouldn't rely on the caller having been filtered somewhere else.
create or replace function public.set_email_access(
  p_email  text,
  p_revoke boolean
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_admin uuid := '650351f4-7164-48df-a983-a722faa6521d';
  v_email text := lower(trim(p_email));
  v_uid   uuid;
begin
  if auth.uid() is distinct from v_admin then
    raise exception 'not authorized';
  end if;

  if v_email is null or v_email = '' then
    return 'invalid';
  end if;

  select id into v_uid from auth.users where lower(email) = v_email;

  if p_revoke then
    -- The admin's own row already shows an "(admin)" badge instead of a Delete
    -- button, but that's a client-side nicety. This is the part that actually
    -- stops you locking yourself out of your own invite list.
    if v_uid = v_admin then
      return 'cannot_revoke_self';
    end if;

    update allowed_emails set deleted_at = now()
     where email = v_email and deleted_at is null;

    if v_uid is not null then
      -- Far enough out to be permanent in practice; reversible by restoring.
      update auth.users set banned_until = now() + interval '100 years'
       where id = v_uid;

      -- Banning stops new tokens being issued, but an existing session would
      -- otherwise keep refreshing itself indefinitely. Dropping both kills the
      -- renewal path. Note the cast: refresh_tokens.user_id is varchar in
      -- GoTrue's schema while sessions.user_id is uuid.
      delete from auth.sessions       where user_id = v_uid;
      delete from auth.refresh_tokens where user_id = v_uid::text;
    end if;

    return 'revoked';
  end if;

  -- Restore. Also the path behind the admin page's "Add" box, so adding a
  -- previously-revoked address back can't leave them on the list but banned.
  insert into allowed_emails (email, deleted_at)
  values (v_email, null)
  on conflict (email) do update set deleted_at = null;

  if v_uid is not null then
    update auth.users set banned_until = null where id = v_uid;
  end if;

  return 'restored';
end;
$function$;

revoke all on function public.set_email_access(text, boolean) from public;
grant execute on function public.set_email_access(text, boolean) to authenticated;

-- Note on what revocation does NOT do, so it isn't discovered later as a
-- surprise: their access token stays valid until it expires (an hour by
-- default), so someone with the app already open can keep reading their own
-- saved words until then. Their data is also left intact on purpose -- this is
-- "no longer allowed in", not "erase this person". To do the latter, delete the
-- user in the dashboard under Authentication -> Users.
