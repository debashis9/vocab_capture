// Redeeming an invite code: the no-waiting path onto Margin. Someone opens
// .../?i=fam2026, puts their email in, and gets their sign-in link straight
// away -- the admin never sees a request at all.
//
// Sibling of approve-access, and it exists for the same reason: letting
// someone in takes two steps, and only one of them can happen in a browser.
// The code check and the invite-list write are in claim_invite_code() (SQL,
// row-locked so max_uses is a real cap); creating the auth.users row and
// mailing them needs the service-role key, which lives only here.
//
// Unlike approve-access there is NO admin check -- that's the point. The code
// is the credential. What stands in for authorization:
//   - the code has to exist, be enabled, be unexpired and be under max_uses
//   - claim_invite_code() also enforces a 30/hour ceiling across all codes,
//     so a leaked unlimited code can't be used as a mail relay
//   - every failure answers the same "invalid_code", so the endpoint can't be
//     used to hunt for valid codes by comparing responses
//
// Deploy: supabase functions deploy redeem-invite

import { createClient } from "jsr:@supabase/supabase-js@2";

const REDIRECT_TO = "https://debashis9.github.io/vocab_capture/";
const ALLOWED_ORIGINS = ["https://debashis9.github.io"];

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

Deno.serve(async (req: Request) => {
  const cors: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
  const allowOrigin = corsOriginFor(req.headers.get("Origin") ?? "");
  if (allowOrigin) cors["Access-Control-Allow-Origin"] = allowOrigin;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  let body: { code?: unknown; email?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400, cors);
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!code || !email) return json({ result: "invalid_code" }, 200, cors);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: claim, error: claimError } = await admin.rpc("claim_invite_code", {
    p_code: code,
    p_email: email,
    p_name: name || null,
  });
  if (claimError) return json({ error: claimError.message }, 500, cors);

  // Anything that isn't a live claim stops here. 200 rather than 4xx on
  // purpose: these are ordinary answers for the person typing, not faults.
  if (claim !== "ok" && claim !== "already_allowed") {
    return json({ result: claim }, 200, cors);
  }

  // Attempted for "already_allowed" too, and that's not redundant -- it's the
  // self-heal. If a previous redemption added someone to the invite list but
  // the invite mail failed, they'd be on the list with no account and no way
  // in, since index.html signs in with shouldCreateUser:false. Coming back and
  // redeeming again lands here and finishes the job. If they genuinely already
  // have an account, this 422s and we say so instead.
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: REDIRECT_TO,
  });

  if (inviteError) {
    const alreadyRegistered = inviteError.status === 422 ||
      /already (been )?registered|already exists/i.test(inviteError.message ?? "");
    if (alreadyRegistered) return json({ result: "already_have_account" }, 200, cors);
    // They're on the invite list but got no mail. Say so plainly rather than
    // claiming success -- redeeming again will retry the invite.
    return json({ result: "invite_failed", error: inviteError.message }, 200, cors);
  }

  return json({ result: "invited" }, 200, cors);
});
