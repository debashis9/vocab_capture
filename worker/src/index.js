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
        ? await lookupGemma(word, book, userMessage, env)
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
// runtimes instead.
const GEMMA_MODEL = "gemma-4-26b-a4b-it";

async function lookupGemma(word, book, userMessage, env) {
  const prompt = `${SYSTEM_PROMPT}

Respond with ONLY a JSON object — no markdown code fences, no commentary before or after — matching exactly this shape:
{"word": string, "pos": string, "definition": string, "example": string, "synonyms": string[], "antonyms": string[]}

${userMessage}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMMA_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  // Gemma 4 returns thinking as a separate part with `thought: true` ahead of
  // the real answer — grabbing parts[0] unconditionally picks up the
  // reasoning scratchpad instead of the final JSON. Skip thought parts.
  const parts = data.candidates?.[0]?.content?.parts || [];
  const rawText = parts.find((p) => !p.thought)?.text;
  if (!rawText) throw new Error("No answer text in Gemma response: " + JSON.stringify(data));

  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return { ...JSON.parse(cleaned), word };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
