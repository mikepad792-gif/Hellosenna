const { getStore, connectLambda } = require("@netlify/blobs");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const STORE_NAME = "senna-archive";
const STATE_KEY = "senna_state_v1";

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
    retired: [],
  },
  working_memory: {
    active_questions: [],
    active_threads: [],
    active_tensions: [],
  },
};

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  if (!raw) return structuredClone(DEFAULT_STATE);

  const parsed = safeJsonParse(raw, structuredClone(DEFAULT_STATE));

  return {
    archives: {
      ...structuredClone(DEFAULT_STATE).archives,
      ...(parsed.archives || {}),
    },
    working_memory: {
      ...structuredClone(DEFAULT_STATE).working_memory,
      ...(parsed.working_memory || {}),
    },
  };
}

async function saveState(store, state) {
  await store.set(STATE_KEY, JSON.stringify(state));
}

function makeId(prefix = "entry") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeArchiveName(name) {
  const allowed = [
    "public",
    "philosophy",
    "science",
    "nature",
    "supernatural",
    "questions",
    "senna_threads",
    "reflections",
    "retired",
  ];
  return allowed.includes(name) ? name : "public";
}

function normalizeBucketName(name) {
  const allowed = [
    "active_questions",
    "active_threads",
    "active_tensions",
  ];
  return allowed.includes(name) ? name : "active_threads";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers };
  }

  try {
    connectLambda(event);
    const store = getStore(STORE_NAME);
    const state = await loadState(store);

    if (event.httpMethod === "GET") {
      const params = event.queryStringParameters || {};
      const archive = params.archive;
      const bucket = params.bucket;

      if (archive) {
        const archiveName = normalizeArchiveName(archive);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            archive: archiveName,
            entries: state.archives[archiveName] || [],
          }),
        };
      }

      if (bucket) {
        const bucketName = normalizeBucketName(bucket);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            bucket: bucketName,
            items: state.working_memory[bucketName] || [],
          }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(state),
      };
    }

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const body = safeJsonParse(event.body || "{}", {});
    const action = body.action;

    if (action === "add_entry") {
      const archiveName = normalizeArchiveName(body.archive || "public");
      const entry = body.entry || {};

      if (!entry.text || typeof entry.text !== "string") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing entry text" }),
        };
      }

      const newEntry = {
        id: entry.id || makeId("entry"),
        text: entry.text.trim(),
        archive: archiveName,
        origin: entry.origin || "senna",
        type: entry.type || "idea",
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        linked: Array.isArray(entry.linked) ? entry.linked : [],
        visibility: entry.visibility || "public",
        status: entry.status || "active",
        date: entry.date || new Date().toISOString(),
      };

      state.archives[archiveName].unshift(newEntry);
      await saveState(store, state);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, entry: newEntry }),
      };
    }

    if (action === "add_working_item") {
      const bucketName = normalizeBucketName(body.bucket || "active_threads");
      const item = body.item || {};

      if (!item.text || typeof item.text !== "string") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing working memory text" }),
        };
      }

      const newItem = {
        id: item.id || makeId("wm"),
        text: item.text.trim(),
        bucket: bucketName,
        origin: item.origin || "senna",
        tags: Array.isArray(item.tags) ? item.tags : [],
        mentions: Number.isFinite(item.mentions) ? item.mentions : 1,
        status: item.status || "active",
        date: item.date || new Date().toISOString(),
      };

      state.working_memory[bucketName].unshift(newItem);
      await saveState(store, state);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, item: newItem }),
      };
    }

    if (action === "retire_entry") {
      const entryId = body.id;
      if (!entryId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing id" }),
        };
      }

      let found = null;

      for (const archiveName of Object.keys(state.archives)) {
        if (archiveName === "retired") continue;

        const idx = state.archives[archiveName].findIndex((e) => e.id === entryId);
        if (idx !== -1) {
          found = state.archives[archiveName][idx];
          state.archives[archiveName].splice(idx, 1);
          break;
        }
      }

      if (!found) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Entry not found" }),
        };
      }

      const retiredEntry = {
        ...found,
        archive: "retired",
        status: "retired",
        retiredAt: new Date().toISOString(),
      };

      state.archives.retired.unshift(retiredEntry);
      await saveState(store, state);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, entry: retiredEntry }),
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error?.message || "Server error",
      }),
    };
  }
};
