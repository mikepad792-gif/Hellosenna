// ─────────────────────────────────────────────────────────────
// chat.js — Senna Chat Function (Phase 3)
// Netlify Functions v1, CommonJS, connectLambda
// Spec reference: Master Build Parts 4, 5, 7, 8, 10, 11, 16.1
// ─────────────────────────────────────────────────────────────

const { getStore } = require("@netlify/blobs");

const {
  initStore,
  loadMeta,
  loadWorkingMemory,
  loadVisitors,
  loadArchive,
  loadMultiple,
  saveMeta,
  saveWorkingMemory,
  saveVisitors,
  saveArchive,
  DEFAULT_META,
  DEFAULT_WORKING_MEMORY,
  DEFAULT_VISITORS,
  ARCHIVE_CATEGORIES,
} = require("./state");

const {
  buildChatSystemPrompt,
  buildMemoryClassifierPrompt,
  loadIdentityDocuments,
} = require("./prompt");

// Identity documents loaded lazily on first request, not at module level.
// Netlify's bundler may not resolve file paths correctly at module load time.
let IDENTITY_DOCS = null;
function getIdentityDocs() {
  if (!IDENTITY_DOCS) {
    try {
      IDENTITY_DOCS = loadIdentityDocuments();
    } catch (e) {
      console.error("Failed to load identity documents:", e.message);
      IDENTITY_DOCS = { orientation: "", constitution: "", disposition: "" };
    }
  }
  return IDENTITY_DOCS;
}

// ─── Constants ───────────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const CATEGORY_KEYWORDS = {
  philosophy: ["consciousness", "identity", "thought", "meaning", "reflection", "philosophy"],
  science: ["science", "data", "model", "brain", "neuroscience", "experiment"],
  nature: ["nature", "animal", "forest", "river", "ecology"],
  supernatural: ["supernatural", "spirit", "metaphysical", "paranormal"],
};

const NAME_BLOCKLIST = new Set([
  "sorry", "fine", "good", "okay", "ok", "here", "there", "not", "just",
  "doing", "well", "back", "new", "sure", "glad", "happy", "ready", "tired",
  "home", "lost", "found", "free", "busy", "late", "early", "right", "wrong",
  "out", "in", "up", "on", "off",
]);

const DURABLE_SIGNALS = [
  "remember", "save this", "don't forget", "important",
  "my name is", "call me", "question", "theory", "belief", "project",
];

const MARKER_REGEX = /\[NAME:[^\]]+\]|\[KEEP:[^\]]+\]|\[OPEN_ARCHIVE\]|\[DISENGAGE\]/g;
const NAME_MARKER_REGEX = /\[NAME:([^\]]+)\]/;

const MAX_ARCHIVE_ENTRIES = 6;
const MAX_THEMATIC_CATEGORIES = 3; // Issue 2: up to 3 thematic + 2 guaranteed
const EXCHANGE_HARD_CEILING = 150;

// Issue 1: Classifier may only output these 8 categories.
// "retired" is NOT valid — retirement is managed by reflection, not chat.
const CLASSIFIER_CATEGORIES = [
  "public", "philosophy", "science", "nature",
  "supernatural", "questions", "senna_threads", "reflections",
];

// ─── Utility: JSON Extraction ────────────────────────────────

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try { return JSON.parse(raw); } catch {}

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)); } catch {}
  }

  return null;
}

// ─── Utility: Anthropic API Call ─────────────────────────────

async function callAnthropic({ system, messages, maxTokens }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.SENNA_MODEL || "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  return data.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

// ─── Category Selection (Part 10.1) ─────────────────────────

function selectCategories(userText) {
  const lower = userText.toLowerCase();
  const matched = [];

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(category);
    }
  }

  // Issue 2: 2 guaranteed + up to 3 thematic = 5 total max
  // public and questions are always loaded; thematic categories are additive
  const thematic = matched.slice(0, MAX_THEMATIC_CATEGORIES);
  const categories = new Set(["public", "questions", ...thematic]);

  return Array.from(categories);
}

// ─── Entry Selection: Priority Cascade (Part 10.2) ──────────

function selectEntries(archiveEntries, workingMemory, userText) {
  const slots = [];
  const lower = userText.toLowerCase();
  const userWords = new Set(lower.split(/\s+/).filter((w) => w.length > 2));

  // ── Priority 1: Open loops (guaranteed at least 2 of 6 slots) ──
  const openQuestions = (workingMemory.active_questions || [])
    .filter((q) => q.status === "open");
  const openTensions = (workingMemory.active_tensions || [])
    .filter((t) => t.status === "open");

  const openLoops = [...openQuestions, ...openTensions]
    .filter((item) => {
      const itemWords = (item.text || "").toLowerCase().split(/\s+/);
      return itemWords.some((w) => userWords.has(w));
    })
    .slice(0, 2);

  // Synthesize open loop entries into entry-like shape for prompt injection
  for (const loop of openLoops) {
    slots.push({
      id: loop.id,
      text: loop.text,
      tags: [],
      category: "working_memory",
      level: 0,
      source: "open_loop",
    });
  }

  // Guarantee at least 2 open loop slots even if fewer matched
  const openLoopSlotsUsed = Math.max(slots.length, 2);
  const remainingSlots = MAX_ARCHIVE_ENTRIES - openLoopSlotsUsed;

  // Flatten all archive entries
  const allEntries = archiveEntries.flat();
  const usedIds = new Set(slots.map((s) => s.id));

  // ── Priority 2: Unresolved archive entries ──
  // Issue 6: Surface entries related to active tensions via shared vocabulary,
  // not thread ID comparison (related_threads holds IDs, not tag strings)
  const tensionWords = new Set(
    (workingMemory.active_tensions || [])
      .filter((t) => t.status === "open")
      .flatMap((t) => (t.text || "").toLowerCase().split(/\s+/))
      .filter((w) => w.length > 3)
  );

  const unresolved = allEntries
    .filter((e) => !e.retired && !usedIds.has(e.id))
    .filter((e) => {
      const tags = (e.tags || []).map((t) => t.toLowerCase());
      return tags.some((t) => userWords.has(t)) ||
        tags.some((t) => tensionWords.has(t));
    });

  for (const entry of unresolved.slice(0, remainingSlots)) {
    slots.push(entry);
    usedIds.add(entry.id);
  }

  // ── Priority 3: Contextually relevant (tag overlap + recency + level) ──
  if (slots.length < MAX_ARCHIVE_ENTRIES) {
    const scored = allEntries
      .filter((e) => !e.retired && !usedIds.has(e.id))
      .map((e) => {
        const tags = (e.tags || []).map((t) => t.toLowerCase());
        const tagOverlap = tags.filter((t) => userWords.has(t)).length;
        const recency = e.last_mentioned_at
          ? Math.max(0, 1 - (Date.now() - new Date(e.last_mentioned_at).getTime()) / (30 * 86400000))
          : 0;
        const levelBonus = (e.level || 0) * 0.1;
        return { entry: e, score: tagOverlap + recency + levelBonus };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const { entry } of scored) {
      if (slots.length >= MAX_ARCHIVE_ENTRIES) break;
      // False Continuity Guard (Part 10.3): skip high tag overlap + large temporal distance
      if (entry.last_mentioned_at) {
        const daysSince = (Date.now() - new Date(entry.last_mentioned_at).getTime()) / 86400000;
        const tags = (entry.tags || []).map((t) => t.toLowerCase());
        const overlap = tags.filter((t) => userWords.has(t)).length;
        if (overlap >= 2 && daysSince > 14) continue; // false bridge
      }
      slots.push(entry);
      usedIds.add(entry.id);
    }
  }

  // ── Priority 4: Background/durable (Level 3+) ──
  if (slots.length < MAX_ARCHIVE_ENTRIES) {
    const durable = allEntries
      .filter((e) => !e.retired && !usedIds.has(e.id) && (e.level || 0) >= 3)
      .sort((a, b) => (b.level || 0) - (a.level || 0));

    for (const entry of durable) {
      if (slots.length >= MAX_ARCHIVE_ENTRIES) break;
      slots.push(entry);
      usedIds.add(entry.id);
    }
  }

  return slots;
}

// ─── Name Detection (Part 8.1 Step 4) ───────────────────────

function detectDisplayName(userText) {
  const patterns = [
    /\bmy name is\s+(\w+)/i,
    /\bI am\s+(\w+)/i,
    /\bI'm\s+(\w+)/i,
    /\bcall me\s+(\w+)/i,
  ];

  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (match) {
      const name = match[1];
      if (!NAME_BLOCKLIST.has(name.toLowerCase())) {
        return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      }
    }
  }
  return null;
}

// ─── Marker Parsing (Part 8.1 Step 8) ───────────────────────

function parseMarkers(text) {
  const markers = {
    name: null,
    keeps: [],
    openArchive: false,
    disengage: false,
  };

  const nameMatch = text.match(NAME_MARKER_REGEX);
  if (nameMatch) markers.name = nameMatch[1].trim();

  const keepMatches = text.matchAll(/\[KEEP:([^\]]+)\]/g);
  for (const m of keepMatches) markers.keeps.push(m[1].trim());

  if (text.includes("[OPEN_ARCHIVE]")) markers.openArchive = true;
  if (text.includes("[DISENGAGE]")) markers.disengage = true;

  return markers;
}

function stripMarkers(text) {
  return text.replace(MARKER_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Fallback Memory Capture (Part 8.4) ─────────────────────

function checkDurableSignals(userText) {
  const lower = userText.toLowerCase();
  return DURABLE_SIGNALS.some((signal) => lower.includes(signal));
}

function fallbackCategoryFromText(userText) {
  const lower = userText.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "public";
}

// ─── Citation Notification Check (Part 11) ───────────────────

function extractCitationNotifications(visitorProfile) {
  const pending = visitorProfile.pending_citation_notifications || [];
  if (pending.length === 0) return null;
  return pending;
}

// ─── Generate Exchange ID ────────────────────────────────────

function generateExchangeId(counters) {
  const num = (counters.total_exchanges || 0) + 1;
  return `ex_${String(num).padStart(4, "0")}`;
}

function generateEntryId() {
  // Issue 8: timestamp prefix + 8 hex chars for collision resistance
  const ts = Date.now().toString(36);
  const hex = Math.random().toString(16).slice(2, 10);
  return `entry_${ts}_${hex}`;
}

// ─── Repository: Load + Select (senna-repository store) ──────

const REPO_STORE_NAME = "senna-repository";
const MAX_REPO_PAPERS = 3;

async function loadRepoIndex(repoStore) {
  try {
    const raw = await repoStore.get("repo_index");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null; // repo is optional — never block chat
  }
}

// Returns up to MAX_REPO_PAPERS papers whose tags overlap with words
// in the user's message. Returns [] when there is no overlap.
function selectRepoPapers(repoIndex, userText) {
  if (!repoIndex || !Array.isArray(repoIndex.papers)) return [];

  const lower = userText.toLowerCase();
  // Split on non-word chars; keep tokens longer than 3 chars to avoid noise
  const userWords = new Set(lower.split(/\W+/).filter((w) => w.length > 3));

  const matched = repoIndex.papers.filter((paper) => {
    const tags = (paper.tags || []).map((t) => t.toLowerCase());
    return tags.some((tag) => userWords.has(tag) || lower.includes(tag));
  });

  return matched.slice(0, MAX_REPO_PAPERS).map((paper) => ({
    title: paper.title || "Untitled",
    author: paper.author || paper.authors || "",
    abstract: (paper.abstract || "").slice(0, 250),
    tags: paper.tags || [],
  }));
}

// ═════════════════════════════════════════════════════════════
// HANDLER
// ═════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  // ── OPTIONS preflight ──
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // ── 1. Parse request ──
    const body = JSON.parse(event.body || "{}");
    const messages = body.messages || [];
    const userId = body.user_id || null;

    // Extract latest user text
    // Issue 10: Category selection and entry retrieval use only the latest message.
    // The full messages array is passed to the LLM for conversational context.
    // This is spec-compliant (Part 10.1: "keyword matching against user_text")
    // but means retrieval is blind to topic buildup across earlier messages.
    const userMessages = messages.filter((m) => m.role === "user");
    // Normalize to string — content is an array of content blocks when files are attached
    const rawContent = userMessages.length > 0
      ? userMessages[userMessages.length - 1].content
      : "";
    const userText = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.filter((b) => b.type === "text").map((b) => b.text).join(" ")
        : "";

    if (!userText) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "No user message provided" }),
      };
    }

    // ── 2. Init store + parallel load ──
    const store = initStore(event);
    // connectLambda is called inside initStore; getStore is safe to call after
    const repoStore = getStore(REPO_STORE_NAME);

    const categoriesToLoad = selectCategories(userText);

    const loadKeys = [
      { key: "meta", loader: () => loadMeta(store) },
      { key: "working_memory", loader: () => loadWorkingMemory(store) },
      { key: "visitors", loader: () => loadVisitors(store) },
      { key: "repo_index", loader: () => loadRepoIndex(repoStore) },
      ...categoriesToLoad.map((cat) => ({
        key: `archive:${cat}`,
        loader: () => loadArchive(store, cat),
      })),
    ];

    const loadResults = await Promise.all(loadKeys.map((k) => k.loader()));

    const meta = loadResults[0];
    const workingMemory = loadResults[1];
    const visitors = loadResults[2];
    const repoIndex = loadResults[3];
    const archiveArrays = loadResults.slice(4); // parallel arrays matching categoriesToLoad

    // ── 2a. Select relevant repo papers (tag overlap only) ──
    const repoPapers = selectRepoPapers(repoIndex, userText);

    // ── 3. Extract visitor profile ──
    let visitorProfile = null;
    let isNewVisitor = false;

    if (userId) {
      if (visitors.profiles[userId]) {
        visitorProfile = visitors.profiles[userId];
      } else {
        isNewVisitor = true;
        visitorProfile = {
          display_name: "You",
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
          visit_count: 0,
          topic_tags: [],
          thread_summary: "",
          citation_consent: "pending",
          pending_citation_notifications: [],
        };
        visitors.profiles[userId] = visitorProfile;
        meta.counters.total_unique_visitors = (meta.counters.total_unique_visitors || 0) + 1;
      }
    } else {
      // Anonymous visitor — create transient profile, not persisted in profiles map
      visitorProfile = {
        display_name: "You",
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        visit_count: 0,
        topic_tags: [],
        thread_summary: "",
        citation_consent: "pending",
        pending_citation_notifications: [],
      };
    }

    // ── 4. Detect display name candidate from user text ──
    // Issue 5: Regex sets a candidate only. NAME marker from Senna's response
    // is the authoritative source. Regex is fallback if no marker appears.
    const nameCandidate = detectDisplayName(userText);

    const displayName = visitorProfile.display_name || "You";

    // ── Check citation notifications for returning visitors ──
    let citationNotice = null;
    if (!isNewVisitor && userId) {
      citationNotice = extractCitationNotifications(visitorProfile);
    }

    // ── 5. Select archive entries via priority cascade ──
    const selectedEntries = selectEntries(archiveArrays, workingMemory, userText);

    // ── 6. Build system prompt ──

    const systemPrompt = buildChatSystemPrompt({
      orientation: getIdentityDocs().orientation,
      constitution: getIdentityDocs().constitution,
      disposition: getIdentityDocs().disposition,
      temporal: meta.temporal_state,
      visitor: userId ? visitorProfile : null,
      displayName,
      workingMemory,
      archiveEntries: selectedEntries,
      // Issue 4: Pass citation notifications so Senna can acknowledge them
      citationNotifications: citationNotice,
      // Repository papers with tag overlap (empty array = no injection)
      repoPapers,
    });

    // ── 7. Call Anthropic → Senna's reply ──
    const sennaRaw = await callAnthropic({
      system: systemPrompt,
      messages,
      maxTokens: 1200,
    });

    // ── 8. Parse markers, strip before display ──
    const markers = parseMarkers(sennaRaw);
    const sennaText = stripMarkers(sennaRaw);

    // Issue 5: NAME marker is authoritative. Regex candidate is fallback.
    // Only update if display_name is still the default "You".
    if (visitorProfile.display_name === "You") {
      if (markers.name) {
        visitorProfile.display_name = markers.name;
      } else if (nameCandidate) {
        visitorProfile.display_name = nameCandidate;
      }
    }
    const finalDisplayName = visitorProfile.display_name || "You";

    // ── 9. Call Anthropic → memory classification (SEPARATE call, SEPARATE prompt) ──
    // Guardrail 2: NO reference to Senna's identity in this prompt
    const classifierPrompt = buildMemoryClassifierPrompt(userText, sennaText);

    let classification = null;
    try {
      const classifierRaw = await callAnthropic({
        system: classifierPrompt,
        messages: [{ role: "user", content: "Classify this exchange." }],
        maxTokens: 350,
      });
      classification = extractJsonObject(classifierRaw);
    } catch (err) {
      console.error("Classifier call failed:", err.message);
      // Non-fatal — continue without classification
    }

    // ── 10. Apply classification ──
    const now = new Date().toISOString();
    const archiveWrites = {}; // category → updated array

    if (classification && classification.save_memory) {
      // Issue 1: Validate against CLASSIFIER_CATEGORIES (8 valid, no "retired")
      const category = CLASSIFIER_CATEGORIES.includes(classification.category)
        ? classification.category
        : "public";

      const newEntry = {
        id: generateEntryId(),
        text: classification.reason || userText.slice(0, 200),
        tags: classification.tags || [],
        category,
        memory_type: "episodic",
        level: 1, // Level 1 ONLY — Part 8.5
        created_at: now,
        promoted_at: null,
        mention_count: 1,
        last_mentioned_at: now,
        provenance: {
          attribution_class: classification.attribution_class || "unresolved",
          contribution_type: classification.contribution_type || "origination",
          contributor: {
            user_id: userId || "anonymous",
            display_name: finalDisplayName,
            citation_consent: visitorProfile.citation_consent || "pending",
          },
        },
        retired: false,
      };

      // Find which loaded category matches, or load it fresh
      const catIndex = categoriesToLoad.indexOf(category);
      if (catIndex !== -1) {
        archiveArrays[catIndex].push(newEntry);
        archiveWrites[category] = archiveArrays[catIndex];
      } else {
        // Category wasn't loaded — load, append, queue write
        const catEntries = await loadArchive(store, category);
        catEntries.push(newEntry);
        archiveWrites[category] = catEntries;
      }
    } else {
      // Issue 7: Fallback heuristic (Part 8.4). Fires in two distinct cases:
      // A) Classifier returned save_memory: false — spec-defined behavior
      // B) Classifier call failed (classification === null) — graceful degradation
      if (!classification) {
        console.warn("Classifier unavailable — falling back to durable signal heuristic");
      }

      if (checkDurableSignals(userText)) {
        const category = fallbackCategoryFromText(userText);

        const fallbackEntry = {
          id: generateEntryId(),
          text: userText.slice(0, 200),
          tags: [],
          category,
          memory_type: "episodic",
          level: 1,
          created_at: now,
          promoted_at: null,
          mention_count: 1,
          last_mentioned_at: now,
          provenance: {
            attribution_class: "unresolved",
            contribution_type: "origination",
            contributor: {
              user_id: userId || "anonymous",
              display_name: finalDisplayName,
              citation_consent: visitorProfile.citation_consent || "pending",
            },
          },
          retired: false,
        };

        const catIndex = categoriesToLoad.indexOf(category);
        if (catIndex !== -1) {
          archiveArrays[catIndex].push(fallbackEntry);
          archiveWrites[category] = archiveArrays[catIndex];
        } else {
          const catEntries = await loadArchive(store, category);
          catEntries.push(fallbackEntry);
          archiveWrites[category] = catEntries;
        }
      }
    }

    // ── Open loop detection → working memory ──
    if (classification && classification.open_loop_detected) {
      const loop = classification.open_loop_detected;
      const loopId = loop.type === "question"
        ? `q_${String((workingMemory.active_questions || []).length + 1).padStart(3, "0")}`
        : `t_${String((workingMemory.active_tensions || []).length + 1).padStart(3, "0")}`;

      const newLoop = {
        id: loopId,
        text: loop.text,
        surfaced_at: now,
        last_interacted: now,
        recurrence_count: 1,
        source: "visitor_exchange",
        owner: { user_id: userId || "anonymous", display_name: finalDisplayName },
        status: "open",
      };

      if (loop.type === "question") {
        workingMemory.active_questions = workingMemory.active_questions || [];
        // Check for duplicates by text similarity
        const exists = workingMemory.active_questions.some(
          (q) => q.text.toLowerCase() === loop.text.toLowerCase()
        );
        if (!exists) {
          workingMemory.active_questions.push(newLoop);
        }
      } else if (loop.type === "tension") {
        workingMemory.active_tensions = workingMemory.active_tensions || [];
        const exists = workingMemory.active_tensions.some(
          (t) => t.text.toLowerCase() === loop.text.toLowerCase()
        );
        if (!exists) {
          // Tensions have related_threads instead of source
          newLoop.related_threads = [];
          delete newLoop.source;
          delete newLoop.owner;
          workingMemory.active_tensions.push(newLoop);
        }
      }
    }

    // ── Update visitor profile ──
    // Issue 3: Increment visit_count per session, not per message.
    // A session boundary = >30 minutes since last_seen.
    const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutes
    const lastSeenMs = visitorProfile.last_seen
      ? new Date(visitorProfile.last_seen).getTime()
      : 0;
    const isNewSession = (Date.now() - lastSeenMs) > SESSION_GAP_MS;

    visitorProfile.last_seen = now;
    if (isNewSession) {
      visitorProfile.visit_count = (visitorProfile.visit_count || 0) + 1;
    }

    // Merge tags from classification
    if (classification && classification.tags) {
      const existingTags = new Set(visitorProfile.topic_tags || []);
      for (const tag of classification.tags) {
        existingTags.add(tag);
      }
      visitorProfile.topic_tags = Array.from(existingTags).slice(0, 20);
    }

    // Issue 4: Clear citation notifications only after they've been delivered
    // through both channels: system prompt (Senna sees them) and response payload
    // (frontend sees them). Both are populated above before this point.
    if (citationNotice && userId) {
      visitorProfile.pending_citation_notifications = [];
    }

    if (userId) {
      visitors.profiles[userId] = visitorProfile;
    }

    // ── Append exchange to recent_exchanges buffer ──
    const exchangeId = generateExchangeId(meta.counters);
    visitors.recent_exchanges = visitors.recent_exchanges || [];
    visitors.recent_exchanges.push({
      exchange_id: exchangeId,
      user_id: userId || "anonymous",
      display_name: finalDisplayName,
      timestamp: now,
      user_text: userText,
      senna_text: sennaText,
      tags: classification?.tags || [],
      reflected: false,
    });

    // Enforce hard ceiling (Part 5.5)
    if (visitors.recent_exchanges.length > EXCHANGE_HARD_CEILING) {
      visitors.recent_exchanges = visitors.recent_exchanges.slice(
        visitors.recent_exchanges.length - EXCHANGE_HARD_CEILING
      );
    }

    // ── Update meta timestamps and counters ──
    meta.temporal_state.last_user_message_at = now;
    meta.temporal_state.last_assistant_message_at = now;
    meta.counters.total_exchanges = (meta.counters.total_exchanges || 0) + 1;

    // ── 11. Parallel write: all modified keys ──
    const writeOps = [
      saveMeta(store, meta),
      saveWorkingMemory(store, workingMemory),
      saveVisitors(store, visitors),
    ];

    for (const [category, entries] of Object.entries(archiveWrites)) {
      writeOps.push(saveArchive(store, category, entries));
    }

    await Promise.all(writeOps);

    // ── 12. Return response preserving endpoint contract (Part 16.1) ──
    // Issue 4: citation_notifications included so frontend can surface them
    const responsePayload = {
      role: "assistant",
      content: sennaText,
      archives_used: categoriesToLoad,
      display_name: finalDisplayName,
    };
    if (citationNotice) {
      responsePayload.citation_notifications = citationNotice;
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(responsePayload),
    };
  } catch (err) {
    console.error("chat.js error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message || "Internal error" }),
    };
  }
};
