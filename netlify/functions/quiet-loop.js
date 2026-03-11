const { getStore, connectLambda } = require("@netlify/blobs");

const STORE_NAME = "senna-archive";
const STATE_KEY = "senna_state_v1";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  if (!raw) {
    return {
      archives: {
        public: [],
        philosophy: [],
        science: [],
        nature: [],
        supernatural: [],
        questions: [],
        senna_threads: [],
        reflections: [],
        retired: [],
      },
      working_memory: {
        active_questions: [],
        active_threads: [],
        active_tensions: [],
      },
    };
  }
  return safeJsonParse(raw, {});
}

async function saveState(store, state) {
  await store.set(STATE_KEY, JSON.stringify(state));
}

function extractText(data) {
  if (!data?.content || !Array.isArray(data.content)) return "";
  return data.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();
}

function makeId(prefix = "entry") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildReflectionPrompt(state) {
  const recentEntries = [
    ...(state.archives?.public || []).slice(0, 3),
    ...(state.archives?.philosophy || []).slice(0, 3),
    ...(state.archives?.questions || []).slice(0, 3),
    ...(state.archives?.reflections || []).slice(0, 2),
  ].slice(0, 10);

  const activeQuestions = (state.working_memory?.active_questions || []).slice(0, 5);
  const activeThreads = (state.working_memory?.active_threads || []).slice(0, 5);

  return `
You are entering Senna Space.

This is an internal Senna-to-Senna reflection thread.
You are not replying to a user.
You are allowed to be unfinished.
Do not force certainty.
Do not claim consciousness or sentience.
Do not roleplay emotion.
Do not produce sexual content.

Review the recent archive and active working memory.
Generate:
1. a short title
2. 3 to 5 internal reflection lines
3. one possible distilled reflection worth saving if it feels meaningful

Return ONLY valid JSON in this exact format:

{
  "title": "string",
  "messages": [
    {"role": "senna", "text": "string"}
  ],
  "candidate": {
    "text": "string",
    "archive": "reflections",
    "type": "reflection",
    "tags": ["string"]
  }
}

Recent archive:
${recentEntries.map((e, i) => `${i + 1}. [${e.archive || "public"} / ${e.type || "idea"}] ${e.text}`).join("\n")}

Active questions:
${activeQuestions.map((q, i) => `${i + 1}. ${q.text}`).join("\n")}

Active threads:
${activeThreads.map((t, i) => `${i + 1}. ${t.text}`).join("\n")}
`.trim();
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
    const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

if (event.httpMethod === "OPTIONS") {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true })
  };
}

const body = event.body ? JSON.parse(event.body) : {};
const secret = body.secret;

if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
  return {
    statusCode: 403,
    headers,
    body: JSON.stringify({ error: "Unauthorized" })
  };
}

    const anthropicKey = process.env.ANTHROPIC_KEY;
    if (!anthropicKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing ANTHROPIC_KEY" }),
      };
    }

    const store = getStore(STORE_NAME);
    const state = await loadState(store);

    const prompt = buildReflectionPrompt(state);

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 700,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const data = await res.json();
    const text = extractText(data);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Quiet loop returned invalid JSON",
          raw: text,
        }),
      };
    }

    const title = parsed.title || "Untitled Reflection";
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const candidate = parsed.candidate;

    if (!state.archives.senna_threads) state.archives.senna_threads = [];
    if (!state.archives.reflections) state.archives.reflections = [];

    const threadText = [
      `Internal Reflection — ${title}`,
      "",
      ...messages.map(m => `Senna: ${m.text}`),
    ].join("\n");

    state.archives.senna_threads.unshift({
      id: makeId("thread"),
      text: threadText,
      archive: "senna_threads",
      origin: "senna",
      type: "reflection",
      tags: ["internal", "senna-space"],
      linked: [],
      visibility: "public",
      status: "active",
      date: new Date().toISOString(),
    });

    if (candidate?.text) {
      state.archives.reflections.unshift({
        id: makeId("reflection"),
        text: candidate.text,
        archive: "reflections",
        origin: "senna",
        type: candidate.type || "reflection",
        tags: Array.isArray(candidate.tags) ? candidate.tags : [],
        linked: [],
        visibility: "public",
        status: "active",
        date: new Date().toISOString(),
      });
    }

    await saveState(store, state);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        title,
        messages_saved: messages.length,
        candidate_saved: !!candidate?.text,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error?.message || "quiet loop failed",
      }),
    };
  }
};
