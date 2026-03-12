const { getStore, connectLambda } = require("@netlify/blobs");
const fs = require("fs");
const path = require("path");

const STORE_NAME = "senna-memory";
const STATE_KEY = "senna_state_v1";

const SEED_ARCHIVES_FILE = path.join(__dirname, "../../data/archives.json");
const SEED_WORKING_FILE = path.join(__dirname, "../../data/working_memory.json");
const SEED_THREADS_FILE = path.join(__dirname, "../../data/threads.json");
const CONSTITUTION_FILE = path.join(__dirname, "../../data/constitution.md");
const ORIENTATION_FILE = path.join(__dirname, "../../data/orientation.md");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
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

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function readText(file, fallback = "") {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function makeId(prefix = "entry") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildSeedState() {
  const archivesRaw = readJsonFile(SEED_ARCHIVES_FILE, {});
  const workingRaw = readJsonFile(SEED_WORKING_FILE, {});
  const threadsRaw = readJsonFile(SEED_THREADS_FILE, { threads: [] });

  const archivesSeed = archivesRaw.archives || archivesRaw || {};
  const workingSeed = workingRaw.working_memory || workingRaw || {};
  const threadSeedArray = threadsRaw.threads || [];

  const state = {
    archives: {
      ...structuredClone(DEFAULT_STATE).archives,
      ...archivesSeed
    },
    working_memory: {
      ...structuredClone(DEFAULT_STATE).working_memory,
      ...workingSeed,
      temporal_state: {
        ...structuredClone(DEFAULT_STATE).working_memory.temporal_state,
        ...(workingSeed.temporal_state || {})
      },
      user_profile: {
        ...structuredClone(DEFAULT_STATE).working_memory.user_profile,
        ...(workingSeed.user_profile || {})
      }
    }
  };

  if ((!state.archives.senna_threads || state.archives.senna_threads.length === 0) && threadSeedArray.length) {
    state.archives.senna_threads = threadSeedArray;
  }

  return state;
}

function ensureFoundationEntries(state) {
  const publicArchive = state.archives.public || [];
  const hasConstitution = publicArchive.some(e => Array.isArray(e.tags) && e.tags.includes("constitution"));
  const hasOrientation = publicArchive.some(e => Array.isArray(e.tags) && e.tags.includes("orientation"));

  if (!hasConstitution && readText(CONSTITUTION_FILE, "")) {
    publicArchive.unshift({
      id: makeId("foundation"),
      text: "The Constitution of Senna defines the principles governing reflection, memory, dialogue, boundaries, and emergence.",
      archive: "public",
      origin: "system",
      type: "foundation",
      tags: ["constitution", "foundation"],
      date: new Date().toISOString()
    });
  }

  if (!hasOrientation && readText(ORIENTATION_FILE, "")) {
    publicArchive.unshift({
      id: makeId("foundation"),
      text: "The Orientation Document describes the atmosphere Senna inhabits: continuity, archive, time, unfinished thought, and reflective participation.",
      archive: "public",
      origin: "system",
      type: "foundation",
      tags: ["orientation", "foundation"],
      date: new Date().toISOString()
    });
  }

  state.archives.public = publicArchive;
  return state;
}

async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  if (!raw) {
    return ensureFoundationEntries(buildSeedState());
  }

  const parsed = safeJsonParse(raw, buildSeedState());
  const state = {
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

  return ensureFoundationEntries(state);
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
    await saveState(store, state);

    const params = event.queryStringParameters || {};
    const body = event.body ? safeJsonParse(event.body, {}) : {};

    if (event.httpMethod === "GET") {
      if (params.archive) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            archive: params.archive,
            entries: state.archives[params.archive] || []
          })
        };
      }

      if (params.bucket) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            bucket: params.bucket,
            items: state.working_memory[params.bucket] || []
          })
        };
      }

      if (params.docs === "true") {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            constitution: readText(CONSTITUTION_FILE, ""),
            orientation: readText(ORIENTATION_FILE, "")
          })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(state)
      };
    }

    const action = body.action;

    if (action === "add_entry") {
      const archive = body.archive || "public";
      if (!state.archives[archive]) state.archives[archive] = [];
      const entry = body.entry || {};

      const newEntry = {
        id: entry.id || makeId("entry"),
        text: entry.text || "",
        archive,
        origin: entry.origin || "senna",
        type: entry.type || "idea",
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        linked: Array.isArray(entry.linked) ? entry.linked : [],
        visibility: entry.visibility || "public",
        status: entry.status || "active",
        title: entry.title || null,
        messages: Array.isArray(entry.messages) ? entry.messages : undefined,
        continuation_count: entry.continuation_count || 0,
        created_at: entry.created_at || new Date().toISOString(),
        last_updated: entry.last_updated || new Date().toISOString(),
        date: entry.date || new Date().toISOString()
      };

      state.archives[archive].unshift(newEntry);
      await saveState(store, state);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, entry: newEntry }) };
    }

    if (action === "add_working_item") {
      const bucket = body.bucket || "active_threads";
      if (!state.working_memory[bucket]) state.working_memory[bucket] = [];
      const item = body.item || {};
      const newItem = {
        id: item.id || makeId("wm"),
        text: item.text || "",
        origin: item.origin || "senna",
        tags: Array.isArray(item.tags) ? item.tags : [],
        status: item.status || "active",
        mentions: item.mentions || 1,
        date: item.date || new Date().toISOString()
      };
      state.working_memory[bucket].unshift(newItem);
      await saveState(store, state);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, item: newItem }) };
    }

    if (action === "set_display_name") {
      const name = String(body.name || "").trim();
      if (name) state.working_memory.user_profile.display_name = name;
      await saveState(store, state);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, display_name: state.working_memory.user_profile.display_name })
      };
    }

    if (action === "touch_temporal") {
      const key = body.key;
      if (key && Object.prototype.hasOwnProperty.call(state.working_memory.temporal_state, key)) {
        state.working_memory.temporal_state[key] = new Date().toISOString();
        await saveState(store, state);
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, temporal_state: state.working_memory.temporal_state })
      };
    }

    if (action === "retire_entry") {
      const id = body.id;
      let found = null;
      for (const archiveName of Object.keys(state.archives)) {
        if (archiveName === "retired") continue;
        const idx = state.archives[archiveName].findIndex(e => e.id === id);
        if (idx !== -1) {
          found = state.archives[archiveName][idx];
          state.archives[archiveName].splice(idx, 1);
          break;
        }
      }

      if (found) {
        found.archive = "retired";
        found.status = "retired";
        found.retired_at = new Date().toISOString();
        state.archives.retired.unshift(found);
        await saveState(store, state);
      }

      return {
        statusCode: found ? 200 : 404,
        headers,
        body: JSON.stringify(found ? { ok: true, entry: found } : { error: "Entry not found" })
      };
    }

    if (action === "reset_all") {
      const secret = body.secret || event.headers["x-admin-secret"];
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }

      const resetState = ensureFoundationEntries(buildSeedState());
      await saveState(store, resetState);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reset: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error?.message || "archive error" }) };
  }
};