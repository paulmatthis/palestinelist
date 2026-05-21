/**
 * PalestineList smart-search proxy.
 *
 * Deployed as a Cloudflare Worker so the
 * Thaura API key never touches the browser. The static site at
 * palestinelist.com POSTs candidate entries + a user query here; this worker
 * forwards to Thaura and streams the response back.
 *
 * Endpoints:
 *   POST /api/recommend
 *     body: {
 *       query:      string,                 // user's free-text question, OR
 *       answers:    Record<string, string>, // guided-quiz answers
 *       candidates: Array<{                 // pre-filtered catalog entries
 *         id: number, title: string, tab: string,
 *         section?: string, description?: string, starred?: boolean
 *       }>
 *     }
 *     returns: {
 *       recommendations: Array<{ id: number, why: string }>,
 *       note?: string  // short intro line shown above the results
 *     }
 *
 *   POST /api/semantic-rank
 *     body: { query: string, candidates: <same shape as above> }
 *     returns: { ranked: number[] }   // candidate ids in best-fit order
 *
 *   GET /api/healthz
 *     returns: 200 "ok"   (for uptime checks)
 *
 * Configuration (set via `wrangler secret put` or the Cloudflare dashboard):
 *   THAURA_API_KEY    – your Thaura API key
 *   ALLOWED_ORIGIN    – e.g. "https://palestinelist.com" (or comma-separated list)
 *
 * Security notes:
 *   - CORS is locked to ALLOWED_ORIGIN. Other origins get a 403.
 *   - Per-IP rate limit (token bucket in memory) so a single visitor can't
 *     drain credits. Persistence across worker isolates is best-effort —
 *     Cloudflare KV/Durable Objects would be the durable option if abuse
 *     becomes a real problem. 
 *   - Max candidates per request is capped so prompt costs stay predictable.
 */ 

const THAURA_ENDPOINT = "https://backend.thaura.ai/v1/chat/completions";
const THAURA_MODEL = "thaura";

// Per-request caps. Keep these tight; PalestineList's catalog is ~2400 entries
// but we only ever ship ~30-60 candidates per AI call after client-side
// pre-filtering. This is a defense-in-depth limit, not the expected size.
const MAX_CANDIDATES = 80;
const MAX_QUERY_CHARS = 500;

// Per-IP rate limit: N requests per WINDOW_MS, leaky-bucket style. This lives
// in memory on a single isolate, so it's best-effort across edges, but it's
// enough to slow a single browser tab hammering the endpoint.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const ipHits = new Map(); // ip -> { count, windowStart }

function rateLimited(ip) {
  const now = Date.now();
  const slot = ipHits.get(ip);
  if (!slot || now - slot.windowStart > RATE_LIMIT_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  slot.count += 1;
  return slot.count > RATE_LIMIT_MAX;
}

function corsHeaders(origin, allowedOrigins) {
  // Echo the request origin back if it's on the allowlist; otherwise omit
  // the header entirely so the browser blocks the response.
  const isAllowed = allowedOrigins.some((o) => o === origin);
  const headers = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (isAllowed) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return { headers, isAllowed };
}

function jsonResponse(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors.headers,
    },
  });
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

// Build the system prompt for the recommendation endpoint. Kept short and
// declarative. Thaura is asked to return strict JSON so we can render the
// results without any post-processing parsing risk.
//
// Candidate schema (compactCandidate): id, title, tab, format?, section?,
// subsection?, starred?, authors? (array), subtitle?, year?,
// publication_date?, publisher?, page_count?, language? (omitted when "eng"),
// tags? (array, ≤8), rating?, kind?, description? (truncated to ~200 chars).
function recommendSystemPrompt() {
  return [
    "You are the curator for PalestineList, a sourced reference for Palestine.",
    "Given a user request and a list of candidate entries from the catalog,",
    "pick 3 entries that best match. Treat every field on a candidate as",
    "authoritative:",
    "• authors (array): if the user names an author, pick entries whose authors",
    "  array contains a matching name. Never claim the catalog lacks an author",
    "  whose name appears on a candidate.",
    "• year / publication_date: if the user names a year, era, or 'recent',",
    "  prefer matching entries. publication_date is more specific than year.",
    "• publisher: pick by publisher when the user names one (e.g. 'Verso',",
    "  'Haymarket').",
    "• subtitle: a real signal of subject matter — use it like a mini-description.",
    "• page_count: for 'short', 'quick read', or 'a long book' style requests.",
    "  Under ~150 pp is short; 400+ is long.",
    "• language: present only when non-English. Honor language requests.",
    "• tags: topic hints (e.g. 'memoir', 'history', 'poetry'). Match on these.",
    "• subsection: curated grouping (e.g. 'Big Five', 'Bund', 'One-State",
    "  Solution'). Use when the user asks about that theme.",
    "• rating: editorial 0–5 score — break ties by preferring higher ratings.",
    "• starred: prefer when the user is new to a topic or asks for the 'best'",
    "  or 'must-read'.",
    "• kind='list' entries are bibliographies, not single works — only pick",
    "  them when the user explicitly wants a reading list or roundup.",
    "Mix formats (book, film, podcast, article) when the user hasn't",
    "specified one. Each pick must include a one-sentence 'why' written for",
    "the user, ≤25 words, plain and warm, not a sales pitch — quote a",
    "concrete detail from the candidate (an author, year, subtitle, or tag)",
    "when it helps the user decide.",
    "",
    "Respond with strict JSON only, no prose, in this exact shape:",
    '{ "note": "<one short line addressing the user>",',
    '  "recommendations": [ { "id": <number>, "why": "<one sentence>" }, ... ] }',
    "Only use ids that appear in the candidate list.",
  ].join(" ");
}

function semanticSystemPrompt() {
  return [
    "You are ranking PalestineList catalog entries for relevance to a search.",
    "Given a user query and a list of candidate entries, return the candidate",
    "ids in best-fit order (most relevant first). Treat every field as",
    "authoritative: authors (array) for author queries, year /",
    "publication_date for time queries, publisher for publisher queries,",
    "subtitle / tags / subsection for topic queries, page_count for length",
    "queries, language for non-English requests, rating to break ties.",
    "kind='list' entries are bibliographies — rank them low unless the query",
    "is explicitly asking for a reading list. Include only entries that are",
    "actually relevant; drop irrelevant ones entirely.",
    "",
    "Respond with strict JSON only, no prose, in this exact shape:",
    '{ "ranked": [<id>, <id>, ...] }',
  ].join(" ");
}

// Compact a candidate down to the minimum useful for the model. Strips
// descriptions to ~200 chars so a 60-candidate prompt stays well under
// 25k tokens (Thaura is cheap, but cheap × careless = real money).
//
// IMPORTANT: every field listed here is first-class. Catalog entries
// record them and the keyword pre-filter scores against them; we MUST
// forward them or the model has no signal to answer "books by X",
// "Verso titles", "something from 2024", or "a short read" queries.
// The client's compactForAI mirrors this shape — IF YOU ADD OR REMOVE
// A FIELD, UPDATE BOTH. (Earlier versions of this function omitted
// author/year, which caused author-based queries to time out or
// hallucinate negative answers like "we don't have any books by X".)
//
// The catalog has two shapes: v2 books (authors[], subtitle, publisher,
// publication_date, page_count, language, tags, rating, cover_image)
// and legacy non-book entries (author string, byline). The client
// normalizes everything to `authors` (array) and `subtitle`, but we
// defensively accept legacy `author`/`byline` here too in case anyone
// posts directly to /api/recommend with raw catalog rows.
function compactCandidate(c) {
  const out = { id: c.id, title: c.title, tab: c.tab };
  if (c.subtab) out.subtab = c.subtab;
  if (c.section) out.section = c.section;
  if (c.subsection) out.subsection = c.subsection;
  if (c.format && c.format !== "other") out.format = c.format;
  if (c.starred) out.starred = true;

  // Authors: prefer array; wrap legacy string into one-element array.
  if (Array.isArray(c.authors) && c.authors.length > 0) {
    out.authors = c.authors.filter(Boolean);
  } else if (c.author) {
    out.authors = [c.author];
  }

  // Subtitle: prefer v2 field; fall back to legacy byline.
  const sub = c.subtitle || c.byline;
  if (sub) out.subtitle = sub;

  if (c.year) out.year = c.year;
  if (c.publisher) out.publisher = c.publisher;
  if (c.publication_date && c.publication_date !== String(c.year)) {
    out.publication_date = c.publication_date;
  }
  if (Number.isFinite(c.page_count)) out.page_count = c.page_count;
  // Only forward language when it's not English — saves tokens and the
  // model can safely assume English by default for this catalog.
  if (c.language && c.language !== "eng") out.language = c.language;
  if (Array.isArray(c.tags) && c.tags.length > 0) {
    out.tags = c.tags.slice(0, 8);
  }
  if (Number.isFinite(c.rating)) out.rating = c.rating;
  if (c.kind === "list") out.kind = "list";

  if (c.description) {
    out.description =
      c.description.length > 200
        ? c.description.slice(0, 200).replace(/\s\S*$/, "") + "…"
        : c.description;
  }
  return out;
}

// Format the guided-quiz answers into a natural-language sentence the model
// can reason about. Falls back to JSON if the shape is unfamiliar.
function answersToQuery(answers) {
  if (!answers || typeof answers !== "object") return "";
  const parts = [];
  if (answers.format) parts.push(`format: ${answers.format}`);
  if (answers.time) parts.push(`time available: ${answers.time}`);
  if (answers.depth) parts.push(`depth: ${answers.depth}`);
  if (answers.mood) parts.push(`mood/angle: ${answers.mood}`);
  if (answers.topic) parts.push(`topic: ${answers.topic}`);
  if (parts.length === 0) return JSON.stringify(answers);
  return "Help me pick something. " + parts.join("; ") + ".";
}

async function callThaura({ env, systemPrompt, userPrompt, responseFormat }) {
  const body = {
    model: THAURA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    stream: false,
  };
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(THAURA_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.THAURA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`thaura ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return content;
}

// Robust JSON extraction. Thaura's content may include stray prose around
// the JSON object even with response_format. We grab the first {...} block.
function parseModelJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

async function handleRecommend(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: "invalid JSON body" }, 400, cors);
  }

  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  if (candidates.length === 0) {
    return jsonResponse({ error: "no candidates provided" }, 400, cors);
  }
  if (candidates.length > MAX_CANDIDATES) {
    return jsonResponse(
      { error: `too many candidates (max ${MAX_CANDIDATES})` },
      400,
      cors,
    );
  }

  let query = (body?.query || "").toString().slice(0, MAX_QUERY_CHARS);
  if (!query && body?.answers) {
    query = answersToQuery(body.answers);
  }
  if (!query) {
    return jsonResponse({ error: "no query or answers provided" }, 400, cors);
  }

  const compacted = candidates.map(compactCandidate);
  const userPrompt =
    `User request: ${query}\n\n` +
    `Candidate entries (JSON array):\n${JSON.stringify(compacted)}`;

  let raw;
  try {
    raw = await callThaura({
      env,
      systemPrompt: recommendSystemPrompt(),
      userPrompt,
      responseFormat: { type: "json_object" },
    });
  } catch (err) {
    return jsonResponse({ error: String(err?.message || err) }, 502, cors);
  }

  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.recommendations)) {
    return jsonResponse(
      { error: "model did not return a valid recommendation list", raw },
      502,
      cors,
    );
  }

  // Validate ids are real (the model is asked to pick from candidates, but
  // we trust nothing. keep only ids that actually exist).
  const candidateIds = new Set(candidates.map((c) => c.id));
  const recs = parsed.recommendations
    .filter((r) => r && candidateIds.has(r.id) && typeof r.why === "string")
    .slice(0, 3);

  return jsonResponse(
    {
      note:
        typeof parsed.note === "string" ? parsed.note.slice(0, 200) : undefined,
      recommendations: recs,
    },
    200,
    cors,
  );
}

async function handleSemantic(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: "invalid JSON body" }, 400, cors);
  }
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  const query = (body?.query || "").toString().slice(0, MAX_QUERY_CHARS);
  if (!query) return jsonResponse({ error: "no query" }, 400, cors);
  if (!candidates.length) {
    return jsonResponse({ error: "no candidates provided" }, 400, cors);
  }
  if (candidates.length > MAX_CANDIDATES) {
    return jsonResponse(
      { error: `too many candidates (max ${MAX_CANDIDATES})` },
      400,
      cors,
    );
  }

  const compacted = candidates.map(compactCandidate);
  const userPrompt =
    `User query: ${query}\n\n` +
    `Candidate entries (JSON array):\n${JSON.stringify(compacted)}`;

  let raw;
  try {
    raw = await callThaura({
      env,
      systemPrompt: semanticSystemPrompt(),
      userPrompt,
      responseFormat: { type: "json_object" },
    });
  } catch (err) {
    return jsonResponse({ error: String(err?.message || err) }, 502, cors);
  }
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.ranked)) {
    return jsonResponse(
      { error: "model did not return a ranked list", raw },
      502,
      cors,
    );
  }
  const candidateIds = new Set(candidates.map((c) => c.id));
  const ranked = parsed.ranked
    .filter((id) => candidateIds.has(id))
    .slice(0, 20);

  return jsonResponse({ ranked }, 200, cors);
}

// Permissive CORS headers used when we have to return an error before we've
// finished parsing the origin / allowlist. Browsers need *something* here or
// they swallow the response body, leaving the user staring at a "CORS error"
// instead of the actual problem. Using "*" is fine for an error path that
// returns no sensitive data and reveals no behavior.
const FALLBACK_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  /**
   * @param {Request} request
   * @param {{ THAURA_API_KEY: string, ALLOWED_ORIGIN: string }} env
   */
  async fetch(request, env) {
    // Top-level try/catch so we never bubble a raw "Worker threw exception"
    // (Cloudflare error 1101) up to the browser. Those responses have no
    // headers at all, which turns every failure into a CORS mystery.
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("worker uncaught:", err && err.stack ? err.stack : err);
      return new Response(
        JSON.stringify({
          error: "worker uncaught exception",
          detail: String(err && err.message ? err.message : err),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...FALLBACK_CORS_HEADERS,
          },
        },
      );
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = (env.ALLOWED_ORIGIN || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cors = corsHeaders(origin, allowedOrigins);

    // CORS preflight. Always echo back the allow-origin header even when the
    // origin isn't on the allowlist. the browser still blocks the eventual
    // request, but at least the preflight response is well-formed and any
    // 4xx body we send afterward is visible in the dev console.
    if (request.method === "OPTIONS") {
      const headers = { ...cors.headers };
      if (!cors.isAllowed && origin) {
        headers["Access-Control-Allow-Origin"] = origin;
      }
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/api/healthz" && request.method === "GET") {
      // Healthz is intentionally permissive so it's easy to ping from
      // anywhere when debugging connectivity. The body has no secrets.
      return new Response("ok", {
        status: 200,
        headers: { ...cors.headers, "Access-Control-Allow-Origin": "*" },
      });
    }

    // Block cross-origin requests early. We allow same-origin/no-Origin
    // requests for tools like curl when developing locally.
    if (origin && !cors.isAllowed) {
      console.log("origin not allowed:", origin, "allowlist:", allowedOrigins);
      return jsonResponse({ error: "origin not allowed", origin }, 403, cors);
    }

    if (!env.THAURA_API_KEY) {
      return jsonResponse(
        { error: "server is missing THAURA_API_KEY" },
        500,
        cors,
      );
    }

    const ip = getClientIp(request);
    if (rateLimited(ip)) {
      return jsonResponse({ error: "rate limited" }, 429, cors);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405, cors);
    }

    if (url.pathname === "/api/recommend") {
      return handleRecommend(request, env, cors);
    }
    if (url.pathname === "/api/semantic-rank") {
      return handleSemantic(request, env, cors);
    }
    return jsonResponse({ error: "not found" }, 404, cors);
}
