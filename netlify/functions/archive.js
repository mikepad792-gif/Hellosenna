
const { getStore, connectLambda } = require("@netlify/blobs");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const STORE_NAME = "senna-archive";
const STATE_KEY = "state_v2";
const PRESENCE_TTL_MS = 2 * 60 * 1000;

const DEFAULT_STATE = {
  entries: [],
  contacts: [],
  sessions: {},
  lastActive: null
};

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  if (!raw) return cloneDefault();
  const parsed = safeJsonParse(raw, cloneDefault());
  return {
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
    sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    lastActive: parsed.lastActive || null
  };
}

async function saveState(store, state) {
  await store.set(STATE_KEY, JSON.stringify(state));
}

function makeId(prefix="id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function pruneSessions(state) {
  const now = Date.now();
  for (const [sid, ts] of Object.entries(state.sessions || {})) {
    if (!ts || (now - ts) > PRESENCE_TTL_MS) delete state.sessions[sid];
  }
}

function presenceCount(state) {
  pruneSessions(state);
  return Math.max(1, Object.keys(state.sessions || {}).length);
}

function requireSecret(secret) {
  return !!process.env.MIKE_SECRET && secret === process.env.MIKE_SECRET;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    connectLambda(event);
    const store = getStore(STORE_NAME);
    const state = await loadState(store);

    if (event.httpMethod === "GET") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          entries: state.entries,
          contacts: state.contacts,
          lastActive: state.lastActive,
          presenceCount: presenceCount(state)
        })
      };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const body = safeJsonParse(event.body || "{}", {});
    const action = body.action;

    if (action === "validate") {
      if (!requireSecret(body.secret)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === "arrive" || action === "ping") {
      if (body.sessionId) state.sessions[body.sessionId] = Date.now();
      pruneSessions(state);
      if (action === "ping") state.lastActive = new Date().toISOString();
      await saveState(store, state);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          presenceCount: presenceCount(state),
          lastActive: state.lastActive,
          entries: state.entries,
          contacts: state.contacts
        })
      };
    }

    if (action === "depart") {
      if (body.sessionId && state.sessions[body.sessionId]) delete state.sessions[body.sessionId];
      pruneSessions(state);
      await saveState(store, state);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, presenceCount: presenceCount(state) })
      };
    }

    if (action === "add") {
      const entry = body.entry || {};
      const type = entry.type || "visitor";
      if (type === "mike" && !requireSecret(body.secret)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      if (!entry.text || typeof entry.text !== "string" || !entry.text.trim()) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing entry text" }) };
      }
      const newEntry = {
        id: makeId("entry"),
        text: entry.text.trim(),
        type,
        createdAt: new Date().toISOString()
      };
      state.entries.unshift(newEntry);
      state.entries = state.entries.slice(0, 500);
      state.lastActive = new Date().toISOString();
      await saveState(store, state);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, entries: state.entries }) };
    }

    if (action === "remove") {
      if (!requireSecret(body.secret)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      state.entries = state.entries.filter(e => e.id !== body.id);
      await saveState(store, state);
      return { statusCode: 200, headers, body: JSON.stringify(state.entries) };
    }

    if (action === "add_contact") {
      const c = body.contact || {};
      if (!c.value || typeof c.value !== "string" || !c.value.trim()) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing contact value" }) };
      }
      const newContact = {
        id: makeId("contact"),
        name: c.name?.trim() || null,
        value: c.value.trim(),
        note: c.note?.trim() || null,
        date: new Date().toISOString()
      };
      state.contacts.unshift(newContact);
      state.contacts = state.contacts.slice(0, 200);
      await saveState(store, state);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, contacts: state.contacts }) };
    }

    if (action === "remove_contact") {
      if (!requireSecret(body.secret)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      state.contacts = state.contacts.filter(c => c.id !== body.id);
      await saveState(store, state);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, contacts: state.contacts }) };
    }

    if (action === "reset_all") {
      if (!requireSecret(body.secret)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      const fresh = cloneDefault();
      await saveState(store, fresh);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reset: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error?.message || "Server error" }) };
  }
};
