import Anthropic from "@anthropic-ai/sdk";

// Same shape as the free-dictionary path's pickBest() output, so the
// frontend's existing render() function works unchanged either way.
const DEFINITION_SCHEMA = {
  type: "object",
  properties: {
    word: { type: "string" },
    pos: { type: "string", description: "Part of speech, e.g. noun, verb, adjective." },
    definition: { type: "string" },
    example: { type: "string", description: "A short, natural example sentence using the word." },
    synonyms: { type: "array", items: { type: "string" } },
    antonyms: { type: "array", items: { type: "string" } },
  },
  required: ["word", "pos", "definition", "example", "synonyms", "antonyms"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the dictionary engine behind Margin, a vocabulary app for readers. \
Given a single word — and optionally the title of the book a reader found it in — return a concise, \
accurate definition. If a book is given, prefer the sense of the word that fits how it's typically \
used in that kind of book, and write the example sentence in a voice that could plausibly belong to \
that book. Keep the definition to one or two sentences and the example to one short sentence. List up \
to 5 synonyms and up to 5 antonyms; use empty arrays if none fit naturally. If the word is obscure or \
archaic, still give your best accurate definition rather than saying you don't know.`;

// Same public values already embedded in index.html — not secrets (the anon
// key is meant to be public; RLS/auth is what actually protects data, same
// exception CLAUDE.md carves out for it elsewhere in this app).
const SUPABASE_URL = "https://tnaifyahobaswxgervcy.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRuYWlmeWFob2Jhc3d4Z2VydmN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MzYzNTgsImV4cCI6MjEwMDIxMjM1OH0.9UCB6mYL99SK5Cq8EgDYYRT-oMGzedPIsGrLXXTrbbc";

// Confirms the caller sent a live Supabase session, not just any bearer
// token — delegates the actual JWT verification to Supabase's own
// /auth/v1/user endpoint rather than reimplementing JWT signature checking
// (algorithm, expiry, signing key) in the Worker. One extra round trip per
// lookup; correctness over shaving latency here.
async function verifySupabaseAuth(request) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  return res.ok;
}

export default {
  async fetch(request, env) {
    // Allow the real GitHub Pages origin (env.ALLOWED_ORIGIN) always, plus
    // any localhost origin so local dev/testing (gemma-test.html, wrangler
    // dev) keeps working after this is deployed for real — CORS is a
    // browser-only restriction, not a security boundary, so reflecting a
    // localhost Origin back here doesn't expose anything a curl request
    // couldn't already reach.
    const requestOrigin = request.headers.get("Origin") || "";
    const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(requestOrigin);
    const allowedOrigin = isLocalhost ? requestOrigin : (env.ALLOWED_ORIGIN || "*");

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      // Authorization added so the browser's CORS preflight actually allows
      // the bearer-token header the auth check below requires.
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    // Require a live Supabase session before spending any quota (Gemini's
    // free tier or the dormant Anthropic key) — without this, the URL alone
    // was enough for anyone to call it, curl included.
    if (!(await verifySupabaseAuth(request))) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, corsHeaders);
    }

    // /define-gemma and /define both need a word (the "Missing 'word'"
    // check used to run unconditionally before routing, which would have
    // wrongly rejected /ocr requests -- they send an image, never a word.
    // /define-gemma is the live path (Gemma 4, free tier). /define is the
    // original Claude Haiku path -- kept in code but effectively dormant,
    // since its ANTHROPIC_API_KEY was never set as a secret on the deployed
    // Worker (only GEMINI_API_KEY was). Any other path is a real 404, not a
    // silent fall-through to /define -- that used to be the behavior here,
    // and it's exactly what turned "wrong URL" into a confusing Anthropic
    // SDK credential error instead of an obvious "not found."
    const url = new URL(request.url);
    let definition;
    try {
      if (url.pathname === "/define-gemma" || url.pathname === "/define") {
        const word = (body.word || "").trim();
        if (!word) return json({ error: "Missing 'word'" }, 400, corsHeaders);
        const book = (body.book || "").trim();
        const userMessage = book ? `Word: "${word}"\nBook: "${book}"` : `Word: "${word}"`;

        if (url.pathname === "/define-gemma") {
          definition = await lookupGemma(word, book, userMessage, env, body.model);
        } else {
          definition = await lookupClaude(userMessage, env);
        }
      } else if (url.pathname === "/ocr") {
        if (!body.image) return json({ error: "Missing 'image'" }, 400, corsHeaders);
        definition = await lookupOcr(body.image, env);
      } else {
        return json({ error: "Not found. Use /define-gemma, /define, or /ocr." }, 404, corsHeaders);
      }
      return json(definition, 200, corsHeaders);
    } catch (err) {
      return json({ error: "Lookup failed", detail: String(err) }, 502, corsHeaders);
    }
  },
};

async function lookupClaude(userMessage, env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      format: { type: "json_schema", schema: DEFINITION_SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No definition returned");
  return JSON.parse(textBlock.text);
}

// EXPERIMENT (gemma-definitions branch): Google's Gemini API, pointed at a
// free Gemma 4 model. Different wire shape from Anthropic's Messages API —
// contents/parts instead of messages/content, response text at
// candidates[0].content.parts[0].text instead of a content-block array.
// Structured-output support isn't confirmed for Gemma the way it is for
// Gemini proper, so the schema is spelled out in the prompt itself and the
// response is parsed defensively (stripping ```json fences some
// instruction-tuned models add even when told not to).
//
// Only gemma-4-26b-a4b-it (26B MoE) and gemma-4-31b-it (31B Dense) are
// actually served by this API per ListModels — smaller variants some blog
// posts mentioned aren't available here, likely meant for on-device/local
// runtimes instead. Selectable per-request (body.model) for side-by-side
// comparison; defaults to the 26B MoE variant tested first.
const GEMMA_MODELS = {
  "26b": "gemma-4-26b-a4b-it",
  "31b": "gemma-4-31b-it",
};

// Deliberately separate from the Claude path's SYSTEM_PROMPT (which doesn't
// need JSON-formatting instructions at all, since Anthropic's structured
// outputs feature guarantees the shape) — trimmed to the minimum that still
// reliably produces strict JSON: the book-context rule, output limits, and
// the exact schema. Dropped the persona framing and the
// obscure/archaic-word fallback clause since testing showed both were
// unnecessary for this model to behave correctly.
const GEMMA_SYSTEM_PROMPT = `Define the given word in 1-2 sentences, with one short example sentence. \
If a book is given, fit the sense and example to that book's context. Up to 5 synonyms, up to 5 \
antonyms (empty arrays if none fit). Output ONLY this JSON, no markdown fences, no other text: \
{"word": string, "pos": string, "definition": string, "example": string, "synonyms": string[], "antonyms": string[]}`;

// Verified directly against the live API (thinkingBudget: 0 is rejected
// outright with "Thinking budget is not supported for this model" — 400).
// thinkingLevel: "minimal" is the real, documented lever for this model
// family and cut a ~12-15s response to ~3.8s in testing.
async function lookupGemma(word, book, userMessage, env, modelKey) {
  const model = GEMMA_MODELS[modelKey] || GEMMA_MODELS["26b"];
  const prompt = `${GEMMA_SYSTEM_PROMPT}\n\n${userMessage}`;

  const startedAt = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "minimal" },
          maxOutputTokens: 300,
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API HTTP ${res.status}: ${await res.text()}`);
  }

  // Streaming (rather than a single generateContent call) is what makes
  // time-to-first-token observable at all — a blocking call only ever gives
  // you a single end-to-end duration, with no way to separate "waiting for
  // the model to start" from "waiting for it to finish."
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let firstTokenAt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // This API's SSE stream uses \r\n line endings, not \n — normalize so
    // the \n\n frame-boundary search below actually matches. Without this,
    // no frame ever splits out (indexOf("\n\n") never finds "\r\n\r\n") and
    // the whole response silently fails to parse.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    // SSE frames are blank-line-separated; each frame's payload line is
    // prefixed "data: ".
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr) continue;

      const chunk = JSON.parse(jsonStr);
      const part = chunk.candidates?.[0]?.content?.parts?.[0];
      // Skip thought parts (still present even at "minimal") — only the
      // real answer text counts as "the first token" for this measurement.
      if (part && !part.thought && part.text) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        fullText += part.text;
      }
    }
  }

  const totalMs = Date.now() - startedAt;
  const ttftMs = firstTokenAt !== null ? firstTokenAt - startedAt : totalMs;

  if (!fullText) throw new Error("No answer text in Gemma stream");

  const cleaned = fullText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return { ...JSON.parse(cleaned), word, _timing: { ttft_ms: ttftMs, total_ms: totalMs } };
}

// Verified live against this exact key (2026-08-02, via a real
// generateContent call with an image + the OCR_PROMPT below): gemma-4-26b-a4b-it
// genuinely accepts image input and returns correctly-boxed, correctly-
// ordered word JSON -- same model already used for /define-gemma, per the
// user's request to keep this on the one model rather than adding a second.
const OCR_MODEL = GEMMA_MODELS["26b"];

// Asks for a word list AND a bounding box per word (Gemini's documented
// normalized-coordinate convention: [ymin, xmin, ymax, xmax], each an
// integer 0-1000 relative to the full image) so the client can let someone
// tap a word directly on their photo instead of scrolling a list of
// hundreds of words from a full page. Schema is spelled out in the prompt
// rather than via responseSchema/responseMimeType -- same reasoning as
// GEMMA_SYSTEM_PROMPT above: structured-output support isn't confirmed for
// whatever model ends up serving this, so defensive prompt+parse is the
// safe default regardless.
const OCR_PROMPT = `Look at this photo of a page or portion of a page from a book. For every \
distinct word visible, return its text and its bounding box using the standard normalized \
coordinate convention: each box is [ymin, xmin, ymax, xmax], integers from 0 to 1000, relative to \
the full image regardless of its actual pixel dimensions. Lowercase each word's text, and strip any \
leading or trailing punctuation from it (commas, periods, quotes, etc.) so it's a clean dictionary \
headword -- but keep the box tight around the word exactly as it appears on the page, punctuation \
included. Skip page numbers and running headers. Output ONLY this JSON, no markdown fences, no \
other text: {"words": [{"text": string, "box": [number, number, number, number]}]}`;

// Plain (non-streaming) generateContent, unlike lookupGemma's
// streamGenerateContent -- the client needs the complete word+box list
// before it can render anything useful, so there's no benefit to the
// streaming/SSE complexity here, and it sidesteps that function's own
// \r\n-frame-parsing bug class entirely.
async function lookupOcr(imageBase64, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: OCR_PROMPT },
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          ],
        }],
        // A page's worth of {"text":...,"box":[...]} entries adds up fast --
        // a real, dense book page (250-300+ words) needs real headroom, not
        // just the definition path's 300. 4096 turned out too tight in live
        // testing (truncated mid-thinking, before any real answer) -- bumped
        // to 12000, well under the model's own 32768 outputTokenLimit.
        // thinkingLevel: "minimal" is not optional here -- verified live
        // that this exact call takes 60s+ (times out) without it and ~9s
        // with it, same tuning lookupGemma already needed for plain text.
        generationConfig: {
          maxOutputTokens: 12000,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  // "thought" parts (the model's internal reasoning) are still present even
  // at thinkingLevel: "minimal" and typically come before the real answer --
  // lookupGemma's own streaming parser already has to skip these; this
  // function was missing that filter entirely, so it was reading the
  // thinking text (or nothing, if the response got cut off mid-thought)
  // instead of the actual word list.
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.find((p) => !p.thought && p.text)?.text;
  if (!text) {
    const finishReason = data.candidates?.[0]?.finishReason;
    throw new Error(`No answer text in Gemini OCR response (finishReason: ${finishReason})`);
  }

  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const parsed = JSON.parse(cleaned);

  // Defensive pass -- the prompt's instructions are a request, not a
  // guarantee: drop anything without real text or a well-formed 4-number
  // box, and strip stray leading/trailing punctuation from the text itself
  // (e.g. a trailing comma breaks an exact-match dictionary lookup even
  // though the AI tab tolerates it fine) regardless of whether the model
  // actually followed that part of the prompt.
  const words = (parsed.words || [])
    .map((w) => (w && typeof w.text === "string")
      ? { ...w, text: w.text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") }
      : w)
    .filter((w) =>
      w && typeof w.text === "string" && w.text &&
      Array.isArray(w.box) && w.box.length === 4 && w.box.every((n) => typeof n === "number")
    );

  return { words };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
