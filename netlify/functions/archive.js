// archive.js — Senna Archive Function
// Handles CRUD for archives and state access.
// Reassembles full state from split keys for backward compat.
// Uses state.js for all blob reads/writes. Uses prompt.js for path resolution.

const {
  initStore,
  loadMeta,
  loadWorkingMemory,
  loadVisitors,
  loadArchive,
  loadMultiple,
  loadSidebarState,
  saveMeta,
  saveWorkingMemory,
  saveVisitors,
  saveArchive,
  saveMultiple,
  loadFullState,
  ARCHIVE_CATEGORIES,
  DEFAULT_META,
  DEFAULT_WORKING_MEMORY,
  DEFAULT_VISITORS,
} = require("./state");

const { loadIdentityDocuments, resolveDataDir } = require("./prompt");

const fs = require("fs");
const path = require("path");

// ─── CORS ───────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

// ─── Seed Data Loader ───────────────────────────────────────────────────────

function loadSeedFile(filename) {
  try {
    const dataDir = resolveDataDir();
    const filePath = path.join(dataDir, filename);
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ensureSeedData(store) {
  // Check if state exists by reading meta
  const meta = await loadMeta(store);

  // If meta has a non-null last_user_message_at, state has been initialized
  if (meta.temporal_state.last_user_message_at !== null) {
    return false; // Already initialized
  }

  // Check if any archive category has data
  const publicEntries = await loadArchive(store, "public");
  if (publicEntries.length > 0) {
    return false; // Already has data
  }

  // Load seed files
  const seedArchives = loadSeedFile("archives.json");
  const seedWorkingMemory = loadSeedFile("working_memory.json");

  const writes = [];

  if (seedArchives && typeof seedArchives === "object") {
    for (const category of ARCHIVE_CATEGORIES) {
      if (Array.isArray(seedArchives[category]) && seedArchives[category].length > 0) {
        writes.push({ key: `archive:${category}`, data: seedArchives[category] });
      }
    }
  }

  if (seedWorkingMemory) {
    writes.push({ key: "working_memory", data: seedWorkingMemory });
  }

  if (writes.length > 0) {
    await saveMultiple(store, writes);
  }

  return true;
}

// ─── Search ─────────────────────────────────────────────────────────────────

function searchEntries(allArchives, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results = [];

  for (const category of ARCHIVE_CATEGORIES) {
    const entries = allArchives[category] || [];
    for (const entry of entries) {
      if (entry.retired) continue;
      const haystack = [
        entry.text || "",
        ...(entry.tags || []),
        entry.category || category,
      ]
        .join(" ")
        .toLowerCase();

      const matches = terms.some((t) => haystack.includes(t));
      if (matches) {
        results.push({
          id: entry.id,
          text: entry.text,
          category: entry.category || category,
          tags: entry.tags || [],
          level: entry.level,
        });
      }
    }
  }

  return results;
}

// ─── GET Handler ────────────────────────────────────────────────────────────

async function handleGet(store, params) {
  // ?docs=true → identity documents (uses prompt.js's robust loader)
  if (params.docs === "true") {
    const { orientation, constitution, disposition } = loadIdentityDocuments();
    return respond(200, { constitution, orientation, disposition });
  }

  // ?view=sidebar&user_id=X → lightweight sidebar (uses state.js's loadSidebarState)
  if (params.view === "sidebar") {
    const userId = params.user_id || null;
    const sidebar = await loadSidebarState(store, userId);
    return respond(200, sidebar);
  }

  // ?archive=category → single category
  if (params.archive) {
    const category = params.archive;
    if (!ARCHIVE_CATEGORIES.includes(category)) {
      return respond(400, { error: `Invalid category: ${category}` });
    }
    const entries = await loadArchive(store, category);
    return respond(200, { archive: category, entries });
  }

  // ?search=query → search across categories
  if (params.search) {
    // Load all archive categories in parallel
    const keys = ARCHIVE_CATEGORIES.map((c) => `archive:${c}`);
    const results = await loadMultiple(store, keys);
    const allArchives = {};
    ARCHIVE_CATEGORIES.forEach((c, i) => {
      allArchives[c] = results[i] || [];
    });
    const searchResults = searchEntries(allArchives, params.search);
    return respond(200, { query: params.search, results: searchResults });
  }

  // No params → full reassembled state (backward compat)
  // Accept user_id so the legacy shape can include a real profile
  await ensureSeedData(store);
  const userId = params.user_id || null;
  const fullState = await loadFullState(store, userId);
  return respond(200, fullState);
}

// ─── POST Handler ───────────────────────────────────────────────────────────

async function handlePost(store, body) {
  const { action } = body;

  if (!action) {
    return respond(400, { error: "Missing action" });
  }

  // ── add_entry ──────────────────────────────────────────────────────────
  if (action === "add_entry") {
    const { category, entry } = body;
    if (!category || !ARCHIVE_CATEGORIES.includes(category)) {
      return respond(400, { error: `Invalid or missing category: ${category}` });
    }
    if (!entry || !entry.text) {
      return respond(400, { error: "Entry must have text" });
    }

    const entries = await loadArchive(store, category);

    const newEntry = {
      id: entry.id || `entry_${Date.now().toString(36)}`,
      text: entry.text,
      tags: entry.tags || [],
      category,
      memory_type: entry.memory_type || "semantic",
      level: entry.level || 1,
      created_at: entry.created_at || new Date().toISOString(),
      promoted_at: null,
      mention_count: entry.mention_count || 0,
      last_mentioned_at: null,
      provenance: entry.provenance || {
        attribution_class: "unresolved",
        contribution_type: "origination",
        contributor: null,
      },
      retired: false,
    };

    entries.push(newEntry);
    await saveArchive(store, category, entries);

    return respond(200, { ok: true, id: newEntry.id, category });
  }

  // ── add_working_item ───────────────────────────────────────────────────
  if (action === "add_working_item") {
    const { bucket, item } = body;
    const validBuckets = ["active_questions", "active_threads", "active_tensions"];

    if (!bucket || !validBuckets.includes(bucket)) {
      return respond(400, { error: `Invalid bucket: ${bucket}. Must be one of: ${validBuckets.join(", ")}` });
    }
    if (!item || !item.text) {
      return respond(400, { error: "Item must have text" });
    }

    const workingMemory = await loadWorkingMemory(store);
    const now = new Date().toISOString();

    if (bucket === "active_questions") {
      const caps = 10;
      const newItem = {
        id: item.id || `q_${Date.now().toString(36)}`,
        text: item.text,
        surfaced_at: now,
        last_interacted: now,
        recurrence_count: 0,
        source: item.source || "manual",
        owner: item.owner || null,
        status: "open",
      };
      workingMemory.active_questions.push(newItem);
      if (workingMemory.active_questions.length > caps) {
        workingMemory.active_questions = workingMemory.active_questions.slice(-caps);
      }
    }

    if (bucket === "active_threads") {
      const caps = 5;
      const newItem = {
        thread_id: item.thread_id || `thread_${Date.now().toString(36)}`,
        title: item.text || item.title,
        last_updated: now,
        status: item.status || "active",
      };
      workingMemory.active_threads.push(newItem);
      if (workingMemory.active_threads.length > caps) {
        workingMemory.active_threads = workingMemory.active_threads.slice(-caps);
      }
    }

    if (bucket === "active_tensions") {
      const caps = 5;
      const newItem = {
        id: item.id || `t_${Date.now().toString(36)}`,
        text: item.text,
        surfaced_at: now,
        last_interacted: now,
        recurrence_count: 0,
        related_threads: item.related_threads || [],
        status: "open",
      };
      workingMemory.active_tensions.push(newItem);
      if (workingMemory.active_tensions.length > caps) {
        workingMemory.active_tensions = workingMemory.active_tensions.slice(-caps);
      }
    }

    await saveWorkingMemory(store, workingMemory);
    return respond(200, { ok: true, bucket });
  }

  // ── set_display_name ───────────────────────────────────────────────────
  if (action === "set_display_name") {
    const { user_id, display_name } = body;
    if (!user_id || !display_name) {
      return respond(400, { error: "user_id and display_name required" });
    }

    const visitors = await loadVisitors(store);
    if (!visitors.profiles[user_id]) {
      visitors.profiles[user_id] = {
        display_name,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        visit_count: 0,
        topic_tags: [],
        thread_summary: "",
        citation_consent: "pending",
        pending_citation_notifications: [],
      };
    } else {
      visitors.profiles[user_id].display_name = display_name;
    }

    await saveVisitors(store, visitors);
    return respond(200, { ok: true, user_id, display_name });
  }

  // ── touch_temporal ─────────────────────────────────────────────────────
  if (action === "touch_temporal") {
    const { field } = body;
    const validFields = [
      "last_user_message_at",
      "last_assistant_message_at",
      "last_reflection_at",
      "last_thread_update_at",
    ];
    if (!field || !validFields.includes(field)) {
      return respond(400, { error: `Invalid field: ${field}` });
    }

    const meta = await loadMeta(store);
    meta.temporal_state[field] = new Date().toISOString();
    await saveMeta(store, meta);

    return respond(200, { ok: true, field, value: meta.temporal_state[field] });
  }

  // ── retire_entry ───────────────────────────────────────────────────────
  if (action === "retire_entry") {
    const { category, entry_id } = body;
    if (!category || !ARCHIVE_CATEGORIES.includes(category)) {
      return respond(400, { error: `Invalid category: ${category}` });
    }
    if (!entry_id) {
      return respond(400, { error: "entry_id required" });
    }

    const entries = await loadArchive(store, category);
    const entryIndex = entries.findIndex((e) => e.id === entry_id);

    if (entryIndex === -1) {
      return respond(404, { error: `Entry ${entry_id} not found in ${category}` });
    }

    // Remove from source category (splice, not mark — matches reflect.js behavior)
    const [entry] = entries.splice(entryIndex, 1);

    // Add to retired archive with retirement metadata
    const retired = await loadArchive(store, "retired");
    retired.push({
      ...entry,
      retired: true,
      retired_at: new Date().toISOString(),
      retired_from: category,
    });

    await Promise.all([
      saveArchive(store, category, entries),
      saveArchive(store, "retired", retired),
    ]);

    return respond(200, { ok: true, entry_id, category, retired: true });
  }

  // ── reset_archive ───────────────────────────────────────────────────────
  // Clears all archive categories to empty arrays.
  // Requires BOTH admin secret AND a separate ARCHIVE_RESET_SECRET env var.
  // Preserves meta, working_memory, and visitors.
  if (action === "reset_archive") {
    const { secret, archive_reset_secret } = body;
    if (secret !== process.env.MIKE_SECRET) {
      return respond(403, { error: "Unauthorized" });
    }
    if (!process.env.ARCHIVE_RESET_SECRET || archive_reset_secret !== process.env.ARCHIVE_RESET_SECRET) {
      return respond(403, { error: "Invalid archive reset secret" });
    }

    const writes = [];
    for (const category of ARCHIVE_CATEGORIES) {
      writes.push({ key: `archive:${category}`, data: [] });
    }

    await saveMultiple(store, writes);
    return respond(200, { ok: true, reset_archive: true, categories_cleared: ARCHIVE_CATEGORIES.length });
  }

  // ── reset_all ──────────────────────────────────────────────────────────
  if (action === "reset_all") {
    const { secret } = body;
    if (secret !== process.env.MIKE_SECRET) {
      return respond(403, { error: "Unauthorized" });
    }

    // Deep copy defaults to prevent reference mutation
    const writes = [
      { key: "meta", data: JSON.parse(JSON.stringify(DEFAULT_META)) },
      { key: "working_memory", data: JSON.parse(JSON.stringify(DEFAULT_WORKING_MEMORY)) },
      { key: "visitors", data: JSON.parse(JSON.stringify(DEFAULT_VISITORS)) },
    ];

    for (const category of ARCHIVE_CATEGORIES) {
      writes.push({ key: `archive:${category}`, data: [] });
    }

    await saveMultiple(store, writes);
    return respond(200, { ok: true, reset: true });
  }

  return respond(400, { error: `Unknown action: ${action}` });
}

// ─── Main Handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // OPTIONS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    const store = initStore(event);

    if (event.httpMethod === "GET") {
      const params = event.queryStringParameters || {};
      return await handleGet(store, params);
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      return await handlePost(store, body);
    }

    return respond(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("archive.js error:", err);
    return respond(500, { error: err.message || "Internal error" });
  }
};
