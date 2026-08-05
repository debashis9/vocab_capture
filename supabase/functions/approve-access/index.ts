// Approving someone off the #admin queue has to do two separate things, and
// only one of them can be done from the browser:
//
//   1. put their email on allowed_emails -- the list the `before insert on
//      auth.users` trigger checks. The admin page could already do this alone.
//   2. create their auth.users row and mail them a link. This needs the
//      service-role key, which must never appear in index.html.
//
// Without (2) nothing actually happens for the person: index.html signs in
// with shouldCreateUser:false, so an email that has no auth.users row can't be
// sent a magic link no matter what allowed_emails says. That gap is why
// inviting used to mean a trip to the Supabase dashboard. This function closes
// it, which is the whole point of it existing.
//
// Deploy: supabase functions deploy approve-access
// (or the Supabase MCP's deploy_edge_function). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by the platform -- no secrets to set.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Same account hardcoded in index.html's ADMIN_USER_ID and in the RLS policies
// on allowed_emails / access_requests. Kept literal rather than read from the
// environment so that misconfiguring an env var can't silently open this up.
const ADMIN_USER_ID = "650351f4-7164-48df-a983-a722faa6521d";

// Where the invite link drops them. Must exactly match an entry in Supabase's
// Authentication -> URL Configuration -> Redirect URLs, or GoTrue quietly
// falls back to Site URL instead -- the failure mode that sent sign-ins to a
// dead localhost address back in July.
const REDIRECT_TO = "https://debashis9.github.io/vocab_capture/";

const ALLOWED_ORIGINS = ["https://debashis9.github.io"];

type ApproveResult = {
  email: string;
  ok: boolean;
  error?: string;
  // false when they already had an account, so no invite mail went out.
  invited?: boolean;
};

// Mirrors the Worker's CORS approach, including its lesson: never fall back to
// "*". An unrecognized origin gets no header at all, so the browser blocks the
// read, rather than the header silently widening to everyone.
function corsOriginFor(origin: string): string {
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return "";
}

function json(payload: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function approveOne(
  admin: SupabaseClient,
  row: { id: number; email: string },
): Promise<ApproveResult> {
  const email = String(row.email).toLowerCase();

  // Order matters and is not cosmetic: check_allowed_email() runs before every
  // insert into auth.users, so inviting first would be rejected by our own
  // trigger. Invite list first, account second.
  const { error: allowError } = await admin
    .from("allowed_emails")
    .upsert({ email, deleted_at: null }, { onConflict: "email" });
  if (allowError) return { email, ok: false, error: allowError.message };

  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    email,
    { redirectTo: REDIRECT_TO },
  );

  // Someone who already has an account can't be invited again -- most likely a
  // person who was removed from the list and is now being let back in. Treat it
  // as success, not failure: they're on the list and their account works, so
  // the normal "Send me a link" box will do the rest. The only thing they don't
  // get is the invite mail.
  const alreadyRegistered = !!inviteError && (
    inviteError.status === 422 ||
    /already (been )?registered|already exists/i.test(inviteError.message ?? "")
  );
  if (inviteError && !alreadyRegistered) {
    return { email, ok: false, error: inviteError.message, invited: false };
  }

  const { error: markError } = await admin
    .from("access_requests")
    .update({
      status: "approved",
      decided_at: new Date().toISOString(),
      decided_by: ADMIN_USER_ID,
    })
    .eq("id", row.id);
  // Deliberately reported as a failure even though the person is now fully let
  // in: leaving the row 'pending' would make it reappear in the queue forever,
  // and a wrong-looking queue is worth surfacing.
  if (markError) return { email, ok: false, error: markError.message };

  return { email, ok: true, invited: !alreadyRegistered };
}

Deno.serve(async (req: Request) => {
  const cors: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
  const allowOrigin = corsOriginFor(req.headers.get("Origin") ?? "");
  if (allowOrigin) cors["Access-Control-Allow-Origin"] = allowOrigin;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing bearer token" }, 401, cors);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // The actual gate. The platform's own verify_jwt only proves the caller sent
  // *a* valid project key, and the anon key is both valid and public -- so it
  // proves nothing about who is calling. This does.
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || caller?.user?.id !== ADMIN_USER_ID) {
    return json({ error: "Not authorized" }, 403, cors);
  }

  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400, cors);
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((n): n is number => Number.isInteger(n))
    : [];
  if (!ids.length) return json({ error: "No request ids given" }, 400, cors);

  // Read the emails from the table rather than trusting any the caller sent:
  // the id is a reference to a request that actually exists, an email in the
  // body would be an arbitrary address to add to the invite list.
  const { data: requests, error: loadError } = await admin
    .from("access_requests")
    .select("id, email, status")
    .in("id", ids)
    .eq("status", "pending");
  if (loadError) return json({ error: loadError.message }, 500, cors);
  if (!requests?.length) return json({ error: "Nothing pending with those ids" }, 404, cors);

  // Sequential on purpose. These send real email through the project's Gmail
  // SMTP, which is rate-limited; firing an "Approve all" batch in parallel is
  // the reliable way to trip that limit and have some of them silently fail.
  const results: ApproveResult[] = [];
  for (const row of requests) {
    results.push(await approveOne(admin, row as { id: number; email: string }));
  }

  return json(
    { results, approved: results.filter((r) => r.ok).length },
    200,
    cors,
  );
});
