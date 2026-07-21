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

    try {
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
      if (!textBlock) {
        return json({ error: "No definition returned" }, 502, corsHeaders);
      }

      const definition = JSON.parse(textBlock.text);
      return json(definition, 200, corsHeaders);
    } catch (err) {
      return json({ error: "Lookup failed", detail: String(err) }, 502, corsHeaders);
    }
  },
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
