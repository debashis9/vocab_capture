// The "Send feedback" button in Margin's footer posts here.
//
// Two halves, in this order and for the same reason approve-access has its own
// order: store it, then try to mail it. The row is the durable copy; the email
// is the notification. If Gmail refuses -- and it does, it's rate-limited and
// occasionally just says no -- the feedback is already safe and the failure is
// recorded on the row rather than being lost with the request.
//
// Identity comes from the caller's Supabase access token, never from the body.
// There is no `email` field in the request for the same reason approve-access
// re-reads emails from the table by id: an address the client supplies is an
// arbitrary address.
//
// Deploy:  supabase functions deploy send-feedback
// Secrets: GMAIL_APP_PASSWORD must be set (Edge Functions -> Secrets, or
//          `supabase secrets set GMAIL_APP_PASSWORD=...`). It's the same Google
//          App Password already configured as the project's custom SMTP
//          password -- the one GoTrue uses to send magic links. Until it is set
//          the mail half is dormant: feedback still lands in the table, and the
//          reason the send failed is written to that row's email_error.
//          SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// Where feedback lands, and who it's sent as. Gmail will only accept a From
// that matches the authenticating account, so these are deliberately the same
// address -- it arrives as a note from yourself, with the sender's real address
// on Reply-To so hitting reply goes to them and not back to you.
const MAILBOX = "debashis9@gmail.com";

const ALLOWED_ORIGINS = ["https://debashis9.github.io"];

// How many pieces of feedback one account may send in an hour. This function
// is only reachable with a real session on an invite-only app, so the threat
// isn't a stranger -- it's a stuck retry loop or a bored tester turning the
// mailbox into a firehose. Ten is far above anything deliberate.
const HOURLY_LIMIT = 10;

const MAX_MESSAGE = 2000;
const MAX_USER_AGENT = 500;
const MAX_VERSION = 40;

// Same rule the Worker and approve-access learned: an unrecognized origin gets
// no allow-origin header at all rather than a fallback to "*".
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

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

async function sendMail(body: {
  from: string;
  message: string;
  userAgent: string | null;
  appVersion: string | null;
  when: string;
}) {
  const password = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!password) throw new Error("GMAIL_APP_PASSWORD is not set");

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: MAILBOX, password },
    },
  });

  // Plain text on purpose. This is mail from you to you; there's nothing to
  // brand, and a text part is the least likely thing to be mangled or filtered.
  const lines = [
    body.message,
    "",
    "---",
    `From:    ${body.from}`,
    `Sent:    ${body.when}`,
    `Version: ${body.appVersion ?? "unknown"}`,
    `Device:  ${body.userAgent ?? "unknown"}`,
  ];

  try {
    await client.send({
      from: `Margin feedback <${MAILBOX}>`,
      to: MAILBOX,
      replyTo: body.from,
      // The sender's address in the subject is what makes the inbox useful at a
      // glance -- every one of these otherwise looks identical.
      subject: `Margin feedback - ${body.from}`,
      content: lines.join("\n"),
    });
  } finally {
    // Gmail holds the connection open otherwise, and the function instance can
    // be reused; closing is not optional.
    await client.close();
  }
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

  // The gate. Unlike approve-access this doesn't check *which* account it is --
  // any signed-in user may send feedback -- but it still has to be a real one,
  // because the platform's verify_jwt only proves the caller sent a valid
  // project key, and the anon key is public.
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  const user = caller?.user;
  if (callerError || !user?.id || !user.email) {
    return json({ error: "Not authorized" }, 403, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400, cors);
  }

  const message = clip(body.message, MAX_MESSAGE);
  if (!message) return json({ error: "Nothing to send." }, 400, cors);
  const userAgent = clip(body.user_agent, MAX_USER_AGENT);
  const appVersion = clip(body.app_version, MAX_VERSION);

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin
    .from("feedback")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gt("created_at", since);
  if (countError) return json({ error: countError.message }, 500, cors);
  if ((count ?? 0) >= HOURLY_LIMIT) {
    return json(
      { error: "That's a lot of feedback in one hour - try again a bit later." },
      429,
      cors,
    );
  }

  const { data: row, error: insertError } = await admin
    .from("feedback")
    .insert({
      user_id: user.id,
      email: user.email,
      message,
      user_agent: userAgent,
      app_version: appVersion,
    })
    .select("id, created_at")
    .single();
  if (insertError) return json({ error: insertError.message }, 500, cors);

  // From here on the caller has already succeeded: their words are stored. A
  // mail failure is recorded and reported as `emailed: false`, not as an error
  // that would invite them to send the same thing again.
  let emailed = false;
  let emailError: string | null = null;
  try {
    await sendMail({
      from: user.email,
      message,
      userAgent,
      appVersion,
      when: new Date(row.created_at).toUTCString(),
    });
    emailed = true;
  } catch (err) {
    emailError = err instanceof Error ? err.message : String(err);
    console.error("send-feedback: mail failed", emailError);
  }

  await admin
    .from("feedback")
    .update({
      emailed_at: emailed ? new Date().toISOString() : null,
      email_error: emailError,
    })
    .eq("id", row.id);

  return json({ ok: true, id: row.id, emailed }, 200, cors);
});
