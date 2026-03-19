// mind.js — Senna Mind Function
// Exposes working memory, temporal state, visitor profile, and identity documents.
// Read-only endpoint. Uses state.js for all blob reads, prompt.js for doc loading.

const {
  initStore,
  loadMeta,
  loadWorkingMemory,
  loadVisitors,
} = require("./state");

const { loadIdentityDocuments } = require("./prompt");

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

// ─── Main Handler ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // OPTIONS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed" });
  }

  try {
    const store = initStore(event);
    const params = event.queryStringParameters || {};
    const userId = params.user_id || null;

    // Parallel load: meta, working memory, visitors
    const [meta, workingMemory, visitors] = await Promise.all([
      loadMeta(store),
      loadWorkingMemory(store),
      loadVisitors(store),
    ]);

    // Extract visitor profile if user_id provided
    let userProfile = null;
    if (userId && visitors.profiles && visitors.profiles[userId]) {
      const p = visitors.profiles[userId];
      userProfile = {
        display_name: p.display_name,
        first_seen: p.first_seen,
        last_seen: p.last_seen,
        visit_count: p.visit_count,
        topic_tags: p.topic_tags || [],
        thread_summary: p.thread_summary || "",
        citation_consent: p.citation_consent || "pending",
      };
    }

    // Load identity documents via prompt.js's robust resolver
    const { constitution, orientation, disposition } = loadIdentityDocuments();

    return respond(200, {
      active_questions: workingMemory.active_questions || [],
      active_threads: workingMemory.active_threads || [],
      active_tensions: workingMemory.active_tensions || [],
      temporal_state: meta.temporal_state || {},
      user_profile: userProfile,
      constitution,
      orientation,
      disposition,
    });
  } catch (err) {
    console.error("mind.js error:", err);
    return respond(500, { error: err.message || "Internal error" });
  }
};
