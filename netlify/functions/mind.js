
const fs = require("fs");
const path = require("path");

const WORKING_FILE = path.join(__dirname, "../../data/working_memory.json");
const CONSTITUTION_FILE = path.join(__dirname, "../../data/constitution.md");
const ORIENTATION_FILE = path.join(__dirname, "../../data/orientation.md");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
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
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readText(file) {
  try {
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const memory = { ...DEFAULT_WORKING, ...readJson(WORKING_FILE, DEFAULT_WORKING) };
  const body = event.body ? JSON.parse(event.body) : {};

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...memory,
        constitution: readText(CONSTITUTION_FILE),
        orientation: readText(ORIENTATION_FILE)
      })
    };
  }

  if (event.httpMethod === "POST") {
    const action = body.action || "add";
    if (action === "add") {
      const bucket = body.bucket || "active_threads";
      const item = body.item || {};
      if (!memory[bucket]) memory[bucket] = [];
      memory[bucket].unshift({
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
      if (name) memory.user_profile.display_name = name;
    } else if (action === "touch_temporal") {
      const key = body.key;
      if (key && memory.temporal_state[key] !== undefined) {
        memory.temporal_state[key] = new Date().toISOString();
      }
    }

    writeJson(WORKING_FILE, memory);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, working_memory: memory })
    };
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: "Method not allowed" })
  };
};
