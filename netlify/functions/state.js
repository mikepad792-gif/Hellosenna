// ============================================================
// SENNA — STATE MODULE (state.js)
// Shared utility for all Netlify Functions.
// All blob reads/writes flow through this module.
// Spec reference: Master Build Parts 3, 4, 5
// ============================================================

const { getStore, connectLambda } = require("@netlify/blobs");

// ------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------

const STORE_NAME = "senna-memory";

const ARCHIVE_CATEGORIES = [
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

const KEYS = {
  META: "meta",
  WORKING_MEMORY: "working_memory",
  VISITORS: "visitors",
};

/** Build the blob key for a given archive category. */
function archiveKey(category) {
  return `archive:${category}`;
}

// ------------------------------------------------------------
// DEFAULT VALUES  (Part 5.6 — exact match)
// ------------------------------------------------------------

const DEFAULT_META = {
  temporal_state: {
    last_user_message_at: null,
    last_assistant_message_at: null,
    last_reflection_at: null,
    last_thread_update_at: null,
  },
  reflection_cursor: null,
  counters: {
    total_exchanges: 0,
    total_reflections: 0,
    total_unique_visitors: 0,
  },
};

const DEFAULT_WORKING_MEMORY = {
  active_questions: [],
  active_threads: [],
  active_tensions: [],
};

const DEFAULT_VISITORS = {
  profiles: {},
  recent_exchanges: [],
};

// ------------------------------------------------------------
// STORE INITIALIZATION
// ------------------------------------------------------------

/**
 * Must be called at the top of every handler before any blob
 * access. Returns the store handle that all other functions use.
 *
 * @param {object} event — the Lambda event from Netlify
 * @returns {object} store — Netlify Blobs store handle
 */
function initStore(event) {
  connectLambda(event);
  return getStore(STORE_NAME);
}

// ------------------------------------------------------------
// VALIDATION
// ------------------------------------------------------------

function validateCategory(category) {
  if (!ARCHIVE_CATEGORIES.includes(category)) {
    throw new Error(
      `Invalid archive category: "${category}". ` +
        `Valid: ${ARCHIVE_CATEGORIES.join(", ")}`
    );
  }
}

// ------------------------------------------------------------
// INTERNAL: safe read with fallback
// ------------------------------------------------------------

/**
 * Read a key from the store, JSON.parse the result, and return
 * the parsed value. If the key is missing or parsing fails,
 * return the provided fallback (deep-copied).
 */
async function safeGet(store, key, fallback) {
  try {
    const raw = await store.get(key);
    if (raw === null || raw === undefined) {
      return JSON.parse(JSON.stringify(fallback));
    }
    return JSON.parse(raw);
  } catch {
    // Corrupted or missing — return defaults
    return JSON.parse(JSON.stringify(fallback));
  }
}

// ------------------------------------------------------------
// LOADERS  (read-only, return data — caller mutates)
// ------------------------------------------------------------

/** Load meta (temporal state, counters, reflection cursor). */
async function loadMeta(store) {
  return safeGet(store, KEYS.META, DEFAULT_META);
}

/** Load working memory (active questions, threads, tensions). */
async function loadWorkingMemory(store) {
  return safeGet(store, KEYS.WORKING_MEMORY, DEFAULT_WORKING_MEMORY);
}

/** Load visitors (profiles map + recent exchanges buffer). */
async function loadVisitors(store) {
  return safeGet(store, KEYS.VISITORS, DEFAULT_VISITORS);
}

/** Load a single archive category. Returns [] if empty. */
async function loadArchive(store, category) {
  validateCategory(category);
  return safeGet(store, archiveKey(category), []);
}

/**
 * Parallel read of arbitrary keys. Returns an array of parsed
 * values in the same order as the keys array. Keys that fail
 * or are missing return null (caller decides default).
 */
async function loadMultiple(store, keys) {
  return Promise.all(
    keys.map(async (key) => {
      try {
        const raw = await store.get(key);
        if (raw === null || raw === undefined) return null;
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
  );
}

// ------------------------------------------------------------
// SAVERS  (write-only — failed writes throw)
// ------------------------------------------------------------

async function saveMeta(store, data) {
  await store.set(KEYS.META, JSON.stringify(data));
}

async function saveWorkingMemory(store, data) {
  await store.set(KEYS.WORKING_MEMORY, JSON.stringify(data));
}

async function saveVisitors(store, data) {
  await store.set(KEYS.VISITORS, JSON.stringify(data));
}

async function saveArchive(store, category, data) {
  validateCategory(category);
  await store.set(archiveKey(category), JSON.stringify(data));
}

/**
 * Parallel write of multiple key-value pairs.
 * Each element: { key: string, data: any }
 * Failed writes throw (caller handles).
 */
async function saveMultiple(store, writes) {
  return Promise.all(
    writes.map(({ key, data }) => store.set(key, JSON.stringify(data)))
  );
}

// ------------------------------------------------------------
// FULL STATE REASSEMBLY  (backward-compat legacy shape)
//
// Returns the shape that the archive GET endpoint (Part 16.2)
// has always returned:
//   {
//     archives: { public: [...], philosophy: [...], ... },
//     working_memory: {
//       active_questions, active_threads, active_tensions,
//       temporal_state, user_profile
//     }
//   }
// ------------------------------------------------------------

async function loadFullState(store, userId) {
  // Parallel read of all keys
  const allKeys = [
    KEYS.META,
    KEYS.WORKING_MEMORY,
    KEYS.VISITORS,
    ...ARCHIVE_CATEGORIES.map(archiveKey),
  ];

  const results = await loadMultiple(store, allKeys);

  // Destructure in order
  const meta = results[0] || JSON.parse(JSON.stringify(DEFAULT_META));
  const wm = results[1] || JSON.parse(JSON.stringify(DEFAULT_WORKING_MEMORY));
  const visitors = results[2] || JSON.parse(JSON.stringify(DEFAULT_VISITORS));

  // Build archives object
  const archives = {};
  ARCHIVE_CATEGORIES.forEach((cat, i) => {
    archives[cat] = results[3 + i] || [];
  });

  // Extract user profile for legacy shape
  const profile = userId && visitors.profiles?.[userId]
    ? visitors.profiles[userId]
    : { display_name: "You" };

  return {
    archives,
    working_memory: {
      active_questions: wm.active_questions || [],
      active_threads: wm.active_threads || [],
      active_tensions: wm.active_tensions || [],
      temporal_state: meta.temporal_state || DEFAULT_META.temporal_state,
      user_profile: profile,
    },
  };
}

// ------------------------------------------------------------
// SIDEBAR STATE ASSEMBLY  (lightweight shape)
//
// Returns the shape for GET /archive?view=sidebar&user_id=X
// (Part 16.2):
//   {
//     visitor_threads:    [{ title, thread_id, last_active }],
//     active_tensions:    [{ text, id }],
//     active_questions:   [{ text, id }],
//     recent_reflections: [{ text, date, id }],
//     recent_threads:     [{ title, thread_id, snippet }]
//   }
//
// Only reads 4 keys — much cheaper than loadFullState.
// ------------------------------------------------------------

const SIDEBAR_TENSION_CAP = 5;
const SIDEBAR_QUESTION_CAP = 5;
const SIDEBAR_RECENT_CAP = 3;

async function loadSidebarState(store, userId) {
  const [wm, visitors, reflections, threads] = await loadMultiple(store, [
    KEYS.WORKING_MEMORY,
    KEYS.VISITORS,
    archiveKey("reflections"),
    archiveKey("senna_threads"),
  ]);

  const workingMemory = wm || JSON.parse(JSON.stringify(DEFAULT_WORKING_MEMORY));
  const visitorsData = visitors || JSON.parse(JSON.stringify(DEFAULT_VISITORS));
  const reflectionEntries = reflections || [];
  const threadEntries = threads || [];

  // --- visitor_threads ---
  // Threads where this visitor appears as a source
  const visitorThreads = [];
  if (userId) {
    for (const thread of threadEntries) {
      const isSource = (thread.entries || []).some((entry) =>
        (entry.sources || []).some((s) => s.user_id === userId)
      );
      if (isSource) {
        visitorThreads.push({
          title: thread.title,
          thread_id: thread.thread_id,
          last_active: thread.last_updated || thread.created_at,
        });
      }
    }
  }

  // --- active_tensions (capped) ---
  const activeTensions = (workingMemory.active_tensions || [])
    .filter((t) => t.status === "open")
    .slice(0, SIDEBAR_TENSION_CAP)
    .map((t) => ({ text: t.text, id: t.id }));

  // --- active_questions (capped) ---
  const activeQuestions = (workingMemory.active_questions || [])
    .filter((q) => q.status === "open")
    .slice(0, SIDEBAR_QUESTION_CAP)
    .map((q) => ({ text: q.text, id: q.id }));

  // --- recent_reflections (most recent N) ---
  const recentReflections = reflectionEntries
    .slice()
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, SIDEBAR_RECENT_CAP)
    .map((r) => ({
      text: r.text,
      date: r.created_at,
      id: r.id,
    }));

  // --- recent_threads (most recent N) ---
  const recentThreads = threadEntries
    .slice()
    .sort((a, b) => (b.last_updated || "").localeCompare(a.last_updated || ""))
    .slice(0, SIDEBAR_RECENT_CAP)
    .map((t) => ({
      title: t.title,
      thread_id: t.thread_id,
      snippet:
        t.entries && t.entries.length > 0
          ? t.entries[t.entries.length - 1].content.slice(0, 140)
          : "",
    }));

  return {
    visitor_threads: visitorThreads,
    active_tensions: activeTensions,
    active_questions: activeQuestions,
    recent_reflections: recentReflections,
    recent_threads: recentThreads,
  };
}

// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------

module.exports = {
  // Constants
  ARCHIVE_CATEGORIES,
  KEYS,
  archiveKey,
  DEFAULT_META,
  DEFAULT_WORKING_MEMORY,
  DEFAULT_VISITORS,

  // Store init
  initStore,

  // Loaders
  loadMeta,
  loadWorkingMemory,
  loadVisitors,
  loadArchive,
  loadMultiple,

  // Savers
  saveMeta,
  saveWorkingMemory,
  saveVisitors,
  saveArchive,
  saveMultiple,

  // Full state
  loadFullState,
  loadSidebarState,
};
