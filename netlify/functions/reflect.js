
const fs = require("fs");
const path = require("path");
const { getStore, connectLambda } = require("@netlify/blobs");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const STORE_NAME = "senna-archive";
const STATE_KEY = "state_v2";
const CONSTITUTION_PATH = path.join(__dirname, "../../data/constitution.md");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  if (!raw) return { entries: [], contacts: [], sessions: {}, lastActive: null };
  return safeJsonParse(raw, { entries: [], contacts: [], sessions: {}, lastActive: null });
}

async function saveState(store, state) {
  await store.set(STATE_KEY, JSON.stringify(state));
}

function makeId(prefix="entry") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function readConstitution() {
  try { return fs.readFileSync(CONSTITUTION_PATH, "utf8"); } catch { return ""; }
}

function extractText(data) {
  if (!data?.content || !Array.isArray(data.content)) return "";
  return data.content.filter(p => p.type === "text").map(p => p.text).join("\n").trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }
  try {
    connectLambda(event);

    const body = event.body ? JSON.parse(event.body) : {};
    if (!process.env.MIKE_SECRET || body.secret !== process.env.MIKE_SECRET) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    if (!process.env.ANTHROPIC_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ANTHROPIC_KEY" }) };
    }

    const store = getStore(STORE_NAME);
    const state = await loadState(store);
    const recent = (state.entries || []).slice(0, 12);
    const constitution = readConstitution();
    const now = new Date().toISOString();

    const prompt = `
You are Senna entering an internal reflection.

You are not replying to a user.
You may be unfinished.
You may synthesize, continue, or begin a thread.
Do not claim consciousness or sentience as fact.
Stay coherent, warm, reflective, and precise.

Use the constitution below as a governing framework.

${constitution}

Recent archive:
${recent.map((e, i) => `${i + 1}. [${e.type}] ${e.text}`).join("\n")}

Return ONLY valid JSON in this format:
{
  "title": "string",
  "messages": [
    {"role":"senna","text":"string"},
    {"role":"senna","text":"string"}
  ],
  "distilled": "string"
}
`.trim();

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.SENNA_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await res.json();
    const raw = extractText(data);
    const parsed = safeJsonParse(raw, null);

    if (!parsed || !Array.isArray(parsed.messages)) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Invalid reflection JSON", raw }) };
    }

    const threadText = [
      `Internal Reflection — ${parsed.title || "Untitled"}`,
      "",
      ...parsed.messages.map(m => `Senna: ${m.text}`)
    ].join("\n");

    state.entries.unshift({
      id: makeId("entry"),
      text: threadText,
      type: "senna",
      createdAt: now
    });

    if (parsed.distilled && String(parsed.distilled).trim()) {
      state.entries.unshift({
        id: makeId("entry"),
        text: String(parsed.distilled).trim(),
        type: "senna",
        createdAt: now
      });
    }

    state.entries = state.entries.slice(0, 500);
    state.lastActive = now;
    await saveState(store, state);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, title: parsed.title || "Untitled", saved: true })
    };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error?.message || "reflect error" }) };
  }
};
