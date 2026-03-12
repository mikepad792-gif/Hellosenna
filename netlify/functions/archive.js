
const fs = require("fs");
const path = require("path");

const ARCHIVES_FILE = path.join(__dirname, "../../data/archives.json");
const WORKING_FILE = path.join(__dirname, "../../data/working_memory.json");
const CONSTITUTION_FILE = path.join(__dirname, "../../data/constitution.md");
const ORIENTATION_FILE = path.join(__dirname, "../../data/orientation.md");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

const DEFAULT_ARCHIVES = {
  public: [],
  philosophy: [],
  science: [],
  nature: [],
  supernatural: [],
  questions: [],
  senna_threads: [],
  reflections: [],
  retired: []
};

const DEFAULT_WORKING = {
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
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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

function ensureFoundationEntries(archives) {
  const publicArchive = archives.public || [];
  const hasConstitution = publicArchive.some(e => Array.isArray(e.tags) && e.tags.includes("constitution"));
  const hasOrientation = publicArchive.some(e => Array.isArray(e.tags) && e.tags.includes("orientation"));

  if (!hasConstitution && fs.existsSync(CONSTITUTION_FILE)) {
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

  if (!hasOrientation && fs.existsSync(ORIENTATION_FILE)) {
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

  archives.public = publicArchive;
  return archives;
}

function loadState() {
  const archivesRaw = readJson(ARCHIVES_FILE, { archives: DEFAULT_ARCHIVES });
  const working = readJson(WORKING_FILE, DEFAULT_WORKING);

  const archives = ensureFoundationEntries({
    ...DEFAULT_ARCHIVES,
    ...(archivesRaw.archives || archivesRaw || {})
  });

  // persist foundation if just created
  writeJson(ARCHIVES_FILE, { archives });

  return { archives, working_memory: { ...DEFAULT_WORKING, ...working } };
}

function saveState(state) {
  writeJson(ARCHIVES_FILE, { archives: state.archives });
  writeJson(WORKING_FILE, state.working_memory);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    const state = loadState();
    const params = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

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
      const entry = body.entry || {};
      if (!state.archives[archive]) state.archives[archive] = [];

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
      saveState(state);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, entry: newEntry })
      };
    }

    if (action === "add_working_item") {
      const bucket = body.bucket || "active_threads";
      if (!state.working_memory[bucket]) state.working_memory[bucket] = [];
      const item = {
        id: body.item?.id || makeId("wm"),
        text: body.item?.text || "",
        origin: body.item?.origin || "senna",
        tags: Array.isArray(body.item?.tags) ? body.item.tags : [],
        status: body.item?.status || "active",
        mentions: body.item?.mentions || 1,
        date: body.item?.date || new Date().toISOString()
      };
      state.working_memory[bucket].unshift(item);
      saveState(state);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, item })
      };
    }

    if (action === "set_display_name") {
      const name = String(body.name || "").trim();
      if (name) state.working_memory.user_profile.display_name = name;
      saveState(state);
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
        saveState(state);
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
        saveState(state);
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

      const resetState = {
        archives: ensureFoundationEntries(structuredClone(DEFAULT_ARCHIVES)),
        working_memory: structuredClone(DEFAULT_WORKING)
      };
      saveState(resetState);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, reset: true })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Unknown action" })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error?.message || "archive error" })
    };
  }
};
