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

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const word = (body.word || "").trim();
    if (!word) {
      return json({ error: "Missing 'word'" }, 400, corsHeaders);
    }
    const book = (body.book || "").trim();
    const userMessage = book ? `Word: "${word}"\nBook: "${book}"` : `Word: "${word}"`;

    // EXPERIMENT (gemma-definitions branch): /define still uses Claude Haiku
    // unchanged. /define-gemma is a parallel path hitting Google's free Gemma 4
    // API, for side-by-side quality comparison before deciding whether to
    // switch. Not wired into the frontend — curl it directly for now.
    const url = new URL(request.url);
    try {
      const definition = url.pathname === "/define-gemma"
        ? await lookupGemma(word, book, userMessage, env, body.model)
        : await lookupClaude(userMessage, env);
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

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
