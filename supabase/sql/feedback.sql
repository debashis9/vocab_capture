-- The table behind the "Send feedback" button in the footer.
--
-- Run once in the Supabase SQL Editor. Safe to re-run: every statement is
-- idempotent.
--
-- Unlike access_requests, there is no public function here and no anon access
-- at all. Feedback is signed-in only, and the only writer is the
-- send-feedback Edge Function, which uses the service-role key and so bypasses
-- RLS entirely. That's why the policies below grant nothing but a read to the
-- admin: nothing else needs to touch this table.
--
-- The table exists rather than the function just sending mail and forgetting,
-- for one reason: mail can fail. Gmail SMTP is rate-limited and occasionally
-- refuses; if the row is written first, a failed send costs the reply, not the
-- feedback itself. email_error records what went wrong so a silent failure is
-- visible rather than assumed.

create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  email       text        not null,
  message     text        not null,
  -- Both sent by index.html and named in the form's own note, not collected
  -- quietly. app_version is read out of CacheStorage, so it's the shell version
  -- the sender is actually running -- which for an installed PWA is often not
  -- the latest one.
  user_agent  text,
  app_version text,
  created_at  timestamptz not null default now(),
  emailed_at  timestamptz,
  email_error text,
  -- For triaging later from #admin, if that's ever built. Nothing reads it yet.
  handled_at  timestamptz,

  -- Ceilings, for the same reason access_requests has them: a caller with a
  -- valid session is still a caller, and an unbounded text column is an
  -- unbounded amount of someone else's storage. 2000 mirrors the textarea's
  -- own maxlength; the other two are generous versions of what a browser
  -- actually sends.
  constraint feedback_message_len    check (char_length(message) between 1 and 2000),
  constraint feedback_user_agent_len check (user_agent is null or char_length(user_agent) <= 500),
  constraint feedback_version_len    check (app_version is null or char_length(app_version) <= 40)
);

create index if not exists feedback_created_at_idx
  on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Only the admin may read it. Same hardcoded UID as every other admin policy in
-- this project (index.html's ADMIN_USER_ID, approve-access's ADMIN_USER_ID).
-- Deliberately no insert/update/delete policy for anyone: writes come from the
-- Edge Function under the service-role key, which RLS doesn't apply to.
--
-- Note what this means for the sender: someone can send feedback and then not
-- read it back. That's the intended shape -- it's a letter, not a thread.
drop policy if exists "admin_select_feedback" on public.feedback;
create policy "admin_select_feedback"
on public.feedback
for select
to authenticated
using (auth.uid() = '650351f4-7164-48df-a983-a722faa6521d'::uuid);
