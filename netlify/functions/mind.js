const { getStore, connectLambda } = require("@netlify/blobs");
const fs = require("fs");
const path = require("path");

const STORE_NAME = "senna-memory";
const STATE_KEY = "senna_state_v1";

const CONSTITUTION_FILE = path.join(__dirname, "../../data/constitution.md");
const ORIENTATION_FILE = path.join(__dirname, "../../data/orientation.md");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

const DEFAULT_STATE = {
  archives: {
    public: [],
    philosophy: [],
    science: [],
    nature: [],
    supernatural: [],
    questions: [],
    senna_threads: [],
    reflections: [],
    retired: []
  },
  working_memory: {
    active_questions: [],
    active_threads: [],
    active_tensions: [],
    temporal_state: {
      last_user_message_at: null,
      last_assistant_message_at: null,
      last_reflection_at: null,
      last_thread_update_at: null
    },
    user_profile: {
      display_name: "You"
    }
  }
};

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function readText(file) {
  try {
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  if (!raw) return structuredClone(DEFAULT_STATE);
  const parsed = safeJsonParse(raw, structuredClone(DEFAULT_STATE));
  return {
    archives: {
      ...structuredClone(DEFAULT_STATE).archives,
      ...(parsed.archives || {})
    },
    working_memory: {
      ...structuredClone(DEFAULT_STATE).working_memory,
      ...(parsed.working_memory || {}),
      temporal_state: {
        ...structuredClone(DEFAULT_STATE).working_memory.temporal_state,
        ...((parsed.working_memory || {}).temporal_state || {})
      },
      user_profile: {
        ...structuredClone(DEFAULT_STATE).working_memory.user_profile,
        ...((parsed.working_memory || {}).user_profile || {})
      }
    }
  };
}

async function saveState(store, state) {
  await store.set(STATE_KEY, JSON.stringify(state));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    connectLambda(event);
    const store = getStore(STORE_NAME);
    const state = await loadState(store);
    const body = event.body ? safeJsonParse(event.body, {}) : {};

    if (event.httpMethod === "GET") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...state.working_memory,
          constitution: readText(CONSTITUTION_FILE),
          orientation: readText(ORIENTATION_FILE)
        })
      };
    }

    const action = body.action || "add";

    if (action === "add") {
      const bucket = body.bucket || "active_threads";
      const item = body.item || {};
      if (!state.working_memory[bucket]) state.working_memory[bucket] = [];
      state.working_memory[bucket].unshift({
        id: item.id || `wm_${Date.now()}`,
        text: item.text || "",
        origin: item.origin || "senna",
        tags: Array.isArray(item.tags) ? item.tags : [],
        mentions: item.mentions || 1,
        status: item.status || "active",
        date: item.date || new Date().toISOString()
      });
    } else if (action === "set_display_name") {
      const name = String(body.name || "").trim();
      if (name) state.working_memory.user_profile.display_name = name;
    } else if (action === "touch_temporal") {
      const key = body.key;
      if (key && state.working_memory.temporal_state[key] !== undefined) {
        state.working_memory.temporal_state[key] = new Date().toISOString();
      }
    }

    await saveState(store, state);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, working_memory: state.working_memory })
    };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error?.message || "mind error" }) };
  }
};