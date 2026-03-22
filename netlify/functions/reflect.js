// ─────────────────────────────────────────────────────────────
// reflect.js — Senna's reflection cycle
// Netlify Function v1 (CommonJS, connectLambda)
//
// Three jobs per cycle:
//   1. Process new exchanges since last reflection
//   2. Tend existing archive (promote / demote / retire)
//   3. Maintain open loops (recurrence, resolution)
//
// Spec references: Parts 4, 5, 6, 7, 9, 16.4
// ─────────────────────────────────────────────────────────────

const {
  initStore,
  loadMeta, loadWorkingMemory, loadVisitors,
  loadMultiple, saveMultiple,
  ARCHIVE_CATEGORIES,
} = require("./state");

const { loadIdentityDocuments, buildReflectionPrompt } = require("./prompt");

// Identity documents loaded lazily on first request
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

// ── Constants ────────────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const WM_CAPS = { questions: 10, threads: 5, tensions: 5 };
const DECAY_THRESHOLDS = { level1_days: 30, level2_days: 60 };
const REFLECTED_PRUNE_DAYS = 7;
const EXCHANGE_HARD_CEILING = 150;

// ── Utilities ────────────────────────────────────────────────

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

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── Tending Candidates Builder ───────────────────────────────

function buildTendingCandidates(allArchiveEntries, workingMemory) {
  const now = new Date().toISOString();
  const candidates = { promotions: [], decays: [], demotions: [], capRetirements: [] };

  for (const entry of allArchiveEntries) {
    if (entry.retired) continue;

    // Level 1, high mention_count → promotion candidate
    if (entry.level === 1 && (entry.mention_count || 0) >= 3) {
      candidates.promotions.push({
        entry_id: entry.id,
        category: entry.category,
        text: entry.text,
        mention_count: entry.mention_count,
        level: entry.level,
      });
    }

    // Level 1, ≤1 mention (initial save counts as 1), age >30 days → decay candidate
    if (
      entry.level === 1 &&
      (entry.mention_count || 0) <= 1 &&
      daysSince(entry.last_mentioned_at || entry.created_at) > DECAY_THRESHOLDS.level1_days
    ) {
      candidates.decays.push({
        entry_id: entry.id,
        category: entry.category,
        text: entry.text,
        age_days: Math.floor(daysSince(entry.created_at)),
      });
    }

    // Level 2, ≤1 mention, age >60 days → demotion candidate
    if (
      entry.level === 2 &&
      (entry.mention_count || 0) <= 1 &&
      daysSince(entry.last_mentioned_at || entry.created_at) > DECAY_THRESHOLDS.level2_days
    ) {
      candidates.demotions.push({
        entry_id: entry.id,
        category: entry.category,
        text: entry.text,
        age_days: Math.floor(daysSince(entry.created_at)),
      });
    }
  }

  // Working memory items exceeding caps → retirement candidates
  const { active_questions = [], active_threads = [], active_tensions = [] } = workingMemory;

  if (active_questions.length > WM_CAPS.questions) {
    const sorted = [...active_questions].sort(
      (a, b) => new Date(a.last_interacted || a.surfaced_at) - new Date(b.last_interacted || b.surfaced_at)
    );
    candidates.capRetirements.push(
      ...sorted.slice(0, active_questions.length - WM_CAPS.questions).map(q => ({
        id: q.id,
        type: "question",
        text: q.text,
      }))
    );
  }

  if (active_threads.length > WM_CAPS.threads) {
    const sorted = [...active_threads].sort(
      (a, b) => new Date(a.last_updated || 0) - new Date(b.last_updated || 0)
    );
    candidates.capRetirements.push(
      ...sorted.slice(0, active_threads.length - WM_CAPS.threads).map(t => ({
        id: t.thread_id,
        type: "thread",
        text: t.title,
      }))
    );
  }

  if (active_tensions.length > WM_CAPS.tensions) {
    const sorted = [...active_tensions].sort(
      (a, b) => new Date(a.last_interacted || a.surfaced_at) - new Date(b.last_interacted || b.surfaced_at)
    );
    candidates.capRetirements.push(
      ...sorted.slice(0, active_tensions.length - WM_CAPS.tensions).map(t => ({
        id: t.id,
        type: "tension",
        text: t.text,
      }))
    );
  }

  return candidates;
}

// ── Apply Reflection Results ─────────────────────────────────

function applyResults(result, {
  threads, reflections, workingMemory, visitors,
  archivesByCategory, meta, newExchanges,
}) {
  const now = new Date().toISOString();
  const citationNotifications = [];

  // ── 1. Thread action ──────────────────────────────────────
  if (result.thread_action) {
    const ta = result.thread_action;

    // Issue 6: Validate senna_synthesized evidence requirement (Part 6.3)
    const VALID_EVIDENCE = [
      "structural_novelty", "relational_novelty", "inferential_novelty",
      "compression_novelty", "diagnostic_novelty",
    ];
    function resolveProvenance(ta) {
      let attrClass = ta.attribution_class || "unresolved";
      const evidence = ta.evidence || null;
      if (attrClass === "senna_synthesized" && !VALID_EVIDENCE.includes(evidence)) {
        // LLM claimed synthesis without earning it — downgrade to unresolved
        attrClass = "unresolved";
      }
      return {
        attribution_class: attrClass,
        contribution_type: ta.contribution_type || "synthesis",
        evidence: attrClass === "senna_synthesized" ? evidence : undefined,
      };
    }

    if (ta.mode === "new" && ta.title && ta.content) {
      const provenance = resolveProvenance(ta);
      const newThread = {
        thread_id: generateId("thread"),
        title: ta.title,
        created_at: now,
        last_updated: now,
        level: 2,
        entries: [{
          timestamp: now,
          content: ta.content,
          provenance,
          sources: (ta.sources || []).map(s => ({
            user_id: s.user_id,
            display_name: s.display_name || "anonymous",
            citation_consent: s.citation_consent || "pending",
          })),
        }],
      };

      threads.push(newThread);

      // Add to working memory active_threads
      workingMemory.active_threads.push({
        thread_id: newThread.thread_id,
        title: newThread.title,
        last_updated: now,
        status: "active",
      });

      // Create citation notifications for sources
      for (const src of newThread.entries[0].sources) {
        if (src.user_id) {
          citationNotifications.push({
            user_id: src.user_id,
            notification: {
              thread_id: newThread.thread_id,
              thread_title: newThread.title,
              contribution_summary: `Your conversation became part of this thread.`,
              created_at: now,
            },
          });
        }
      }

      meta.temporal_state.last_thread_update_at = now;

    } else if (ta.mode === "continue" && ta.thread_id && ta.content) {
      const existing = threads.find(t => t.thread_id === ta.thread_id);
      if (existing) {
        const provenance = resolveProvenance(ta);
        existing.last_updated = now;
        existing.entries.push({
          timestamp: now,
          content: ta.content,
          provenance,
          sources: (ta.sources || []).map(s => ({
            user_id: s.user_id,
            display_name: s.display_name || "anonymous",
            citation_consent: s.citation_consent || "pending",
          })),
        });

        // Update working memory thread entry
        const wmThread = workingMemory.active_threads.find(
          t => t.thread_id === ta.thread_id
        );
        if (wmThread) {
          wmThread.last_updated = now;
        }

        // Citation notifications
        for (const src of ta.sources || []) {
          if (src.user_id) {
            citationNotifications.push({
              user_id: src.user_id,
              notification: {
                thread_id: existing.thread_id,
                thread_title: existing.title,
                contribution_summary: `Your conversation was woven into this thread.`,
                created_at: now,
              },
            });
          }
        }

        meta.temporal_state.last_thread_update_at = now;
      }
    }
  }

  // ── 2. Reflection entry ───────────────────────────────────
  // New reflections enter at Level 1 (episodic). Promotion to Level 2
  // happens in a subsequent reflection cycle if the idea shows recurrence.
  if (result.reflection && result.reflection.content) {
    reflections.push({
      id: generateId("ref"),
      text: result.reflection.content,
      tags: result.reflection.tags || [],
      category: "reflections",
      memory_type: "semantic",
      level: 1,
      created_at: now,
      promoted_at: null,
      mention_count: 0,
      last_mentioned_at: null,
      provenance: {
        attribution_class: "senna_synthesized",
        contribution_type: "synthesis",
        evidence: "inferential_novelty",
      },
      retired: false,
    });
  }

  // ── 3. New questions → working memory ─────────────────────
  if (Array.isArray(result.new_questions)) {
    for (const q of result.new_questions) {
      if (!q.text) continue;
      workingMemory.active_questions.push({
        id: generateId("q"),
        text: q.text,
        surfaced_at: now,
        last_interacted: now,
        recurrence_count: 1,
        source: q.source || "reflection",
        owner: q.owner || null,
        status: "open",
      });
    }
  }

  // ── 4. New tensions → working memory ──────────────────────
  if (Array.isArray(result.new_tensions)) {
    for (const t of result.new_tensions) {
      if (!t.text) continue;
      workingMemory.active_tensions.push({
        id: generateId("t"),
        text: t.text,
        surfaced_at: now,
        last_interacted: now,
        recurrence_count: 1,
        related_threads: t.related_threads || [],
        status: "open",
      });
    }
  }

  // ── 5. Promotions ─────────────────────────────────────────
  if (Array.isArray(result.promotions)) {
    for (const promo of result.promotions) {
      for (const cat of Object.keys(archivesByCategory)) {
        const entry = archivesByCategory[cat].find(e => e.id === promo.entry_id);
        if (entry) {
          entry.level = promo.new_level;
          entry.promoted_at = now;
          break;
        }
      }
    }
  }

  // ── 6. Retirements ────────────────────────────────────────
  if (Array.isArray(result.retirements)) {
    for (const ret of result.retirements) {
      for (const cat of Object.keys(archivesByCategory)) {
        const entry = archivesByCategory[cat].find(e => e.id === ret.entry_id);
        if (entry) {
          entry.retired = true;
          // Move to retired category
          if (cat !== "retired") {
            archivesByCategory.retired = archivesByCategory.retired || [];
            archivesByCategory.retired.push({ ...entry });
            archivesByCategory[cat] = archivesByCategory[cat].filter(
              e => e.id !== ret.entry_id
            );
          }
          break;
        }
      }
    }
  }

  // ── 7. Demotions ──────────────────────────────────────────
  if (Array.isArray(result.demotions)) {
    for (const dem of result.demotions) {
      for (const cat of Object.keys(archivesByCategory)) {
        const entry = archivesByCategory[cat].find(e => e.id === dem.entry_id);
        if (entry) {
          entry.level = dem.new_level;
          break;
        }
      }
    }
  }

  // ── 8a. Surfaced visitor contributions ────────────────────
  // When reflection marks a visitor contribution as worth surfacing
  // publicly on The Field, set surfaced:true on the target entry.
  if (Array.isArray(result.surfaced_contributions)) {
    for (const sc of result.surfaced_contributions) {
      if (!sc.entry_id) continue;
      for (const cat of Object.keys(archivesByCategory)) {
        const entry = archivesByCategory[cat].find(e => e.id === sc.entry_id);
        if (entry) {
          entry.surfaced = true;
          entry.surfaced_at = now;
          break;
        }
      }
    }
  }

  // ── 8b. Contestations ─────────────────────────────────────
  // When a visitor challenges an existing archive entry, record it.
  if (Array.isArray(result.contestations)) {
    for (const con of result.contestations) {
      if (!con.target_entry_id) continue;
      for (const cat of Object.keys(archivesByCategory)) {
        const entry = archivesByCategory[cat].find(e => e.id === con.target_entry_id);
        if (entry) {
          if (!entry.contested) {
            entry.contested = {
              is_contested: true,
              challenges: [],
              last_contested: now,
              challenge_count: 0,
            };
          }
          const challengerProfile = visitors.profiles[con.challenger_user_id] || {};
          entry.contested.challenges.push({
            challenge_id: generateId("ch"),
            nature: con.nature || "",
            challenger: {
              display_name: challengerProfile.display_name || "a visitor",
              citation_consent: con.citation_consent || "pending",
            },
            surfaced_at: now,
            source_exchange_id: con.exchange_id || null,
          });
          entry.contested.last_contested = now;
          entry.contested.challenge_count = entry.contested.challenges.length;
          break;
        }
      }
    }
  }

  // ── 8. Open loop resolutions ──────────────────────────────
  // NOTE: "recur" action is handled here but must also be documented
  // in the reflection prompt's output format (prompt.js) or the LLM
  // will never emit it. Valid actions: "resolve", "retire", "recur".
  if (Array.isArray(result.loop_resolutions)) {
    for (const lr of result.loop_resolutions) {
      const q = workingMemory.active_questions.find(x => x.id === lr.id);
      if (q) {
        if (lr.action === "retire" || lr.action === "resolve") {
          q.status = "resolved";
        } else if (lr.action === "recur") {
          q.recurrence_count = (q.recurrence_count || 0) + 1;
          q.last_interacted = now;
        }
        continue;
      }
      const t = workingMemory.active_tensions.find(x => x.id === lr.id);
      if (t) {
        if (lr.action === "retire" || lr.action === "resolve") {
          t.status = "resolved";
        } else if (lr.action === "recur") {
          t.recurrence_count = (t.recurrence_count || 0) + 1;
          t.last_interacted = now;
        }
      }
    }
  }

  // ── 9. Working memory retirements ─────────────────────────
  if (Array.isArray(result.working_memory_retirements)) {
    for (const wmr of result.working_memory_retirements) {
      workingMemory.active_questions = workingMemory.active_questions.filter(
        q => q.id !== wmr.id
      );
      workingMemory.active_tensions = workingMemory.active_tensions.filter(
        t => t.id !== wmr.id
      );
      workingMemory.active_threads = workingMemory.active_threads.filter(
        t => t.thread_id !== wmr.id
      );
    }
  }

  // Remove resolved items from working memory
  workingMemory.active_questions = workingMemory.active_questions.filter(
    q => q.status !== "resolved"
  );
  workingMemory.active_tensions = workingMemory.active_tensions.filter(
    t => t.status !== "resolved"
  );

  // ── 10. Enforce working memory caps ───────────────────────
  if (workingMemory.active_questions.length > WM_CAPS.questions) {
    workingMemory.active_questions.sort(
      (a, b) => new Date(b.last_interacted || b.surfaced_at) - new Date(a.last_interacted || a.surfaced_at)
    );
    workingMemory.active_questions = workingMemory.active_questions.slice(0, WM_CAPS.questions);
  }
  if (workingMemory.active_threads.length > WM_CAPS.threads) {
    workingMemory.active_threads.sort(
      (a, b) => new Date(b.last_updated || 0) - new Date(a.last_updated || 0)
    );
    workingMemory.active_threads = workingMemory.active_threads.slice(0, WM_CAPS.threads);
  }
  if (workingMemory.active_tensions.length > WM_CAPS.tensions) {
    workingMemory.active_tensions.sort(
      (a, b) => new Date(b.last_interacted || b.surfaced_at) - new Date(a.last_interacted || a.surfaced_at)
    );
    workingMemory.active_tensions = workingMemory.active_tensions.slice(0, WM_CAPS.tensions);
  }

  // ── 11. Constitutional candidate (store, do NOT auto-merge)
  // Stored at Level 1 with a flag — NOT Level 4 (canonical).
  // Level 4 requires Mike's explicit review and promotion.
  let candidateSaved = false;
  if (result.constitutional_candidate && result.constitutional_candidate.content) {
    reflections.push({
      id: generateId("const_candidate"),
      text: `[CONSTITUTIONAL CANDIDATE — ${result.constitutional_candidate.target_document || "unspecified"}]\n${result.constitutional_candidate.content}\nReason: ${result.constitutional_candidate.reason || "none given"}`,
      tags: ["constitutional_candidate"],
      category: "reflections",
      memory_type: "identity",
      level: 1,
      constitutional_candidate: true,
      target_document: result.constitutional_candidate.target_document || null,
      created_at: now,
      promoted_at: null,
      mention_count: 0,
      last_mentioned_at: null,
      provenance: {
        attribution_class: "senna_synthesized",
        contribution_type: "revision",
        evidence: "compression_novelty",
      },
      retired: false,
    });
    candidateSaved = true;
  }

  // ── 12. Mark exchanges as reflected ───────────────────────
  for (const ex of newExchanges) {
    ex.reflected = true;
  }

  // ── 13. Prune old reflected exchanges (>7 days) ───────────
  const pruneThreshold = Date.now() - REFLECTED_PRUNE_DAYS * 86400000;
  visitors.recent_exchanges = visitors.recent_exchanges.filter(ex => {
    if (!ex.reflected) return true; // unreflected = never prune by age
    return new Date(ex.timestamp).getTime() > pruneThreshold;
  });

  // ── 14. Hard ceiling on exchange buffer ────────────────────
  // Exchanges are appended chronologically. Drop oldest (front) to stay under ceiling.
  if (visitors.recent_exchanges.length > EXCHANGE_HARD_CEILING) {
    visitors.recent_exchanges = visitors.recent_exchanges.slice(
      visitors.recent_exchanges.length - EXCHANGE_HARD_CEILING
    );
  }

  // ── 15. Apply citation notifications to visitor profiles ──
  for (const cn of citationNotifications) {
    const profile = visitors.profiles[cn.user_id];
    if (profile) {
      if (!profile.pending_citation_notifications) {
        profile.pending_citation_notifications = [];
      }
      profile.pending_citation_notifications.push(cn.notification);
    }
  }

  return { candidateSaved };
}

// ── Main Handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  // OPTIONS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // Admin secret check
  const body = (() => {
    try { return JSON.parse(event.body || "{}"); } catch { return {}; }
  })();
  const secret = body.secret || event.headers["x-admin-secret"] || "";
  if (secret !== process.env.MIKE_SECRET) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  try {
    const store = initStore(event);
    const now = new Date().toISOString();

    // ── Step 1: Parallel load ─────────────────────────────────
    // Use dedicated loaders for structured keys (deep-copy defaults)
    // Use loadMultiple for archive arrays (default to [])
    const [metaRef, wmRef, visitorsRef, archiveArrays] =
      await Promise.all([
        loadMeta(store),
        loadWorkingMemory(store),
        loadVisitors(store),
        loadMultiple(store, [
          "archive:senna_threads", "archive:reflections",
          "archive:public", "archive:philosophy", "archive:science",
          "archive:nature", "archive:supernatural", "archive:questions",
          "archive:retired",
        ]),
      ]);

    const [threads, reflections, archPublic, archPhilosophy,
           archScience, archNature, archSupernatural,
           archQuestions, archRetired] = archiveArrays;

    // Organize archives by category for mutation
    const archivesByCategory = {
      public: archPublic || [],
      philosophy: archPhilosophy || [],
      science: archScience || [],
      nature: archNature || [],
      supernatural: archSupernatural || [],
      questions: archQuestions || [],
      senna_threads: threads || [],
      reflections: reflections || [],
      retired: archRetired || [],
    };

    const threadsRef = archivesByCategory.senna_threads;
    const reflectionsRef = archivesByCategory.reflections;

    // ── Step 2: Filter exchanges by reflection cursor ─────────
    const cursor = metaRef.reflection_cursor;
    const allExchanges = visitorsRef.recent_exchanges || [];

    const newExchanges = cursor
      ? allExchanges.filter(
          ex => !ex.reflected && new Date(ex.timestamp) > new Date(cursor)
        )
      : allExchanges.filter(ex => !ex.reflected);

    // ── Step 3: Determine mode ────────────────────────────────
    const hasNewExchanges = newExchanges.length > 0;

    // ── Step 4: Build tending candidates ──────────────────────
    const allEntries = [
      ...archivesByCategory.public,
      ...archivesByCategory.philosophy,
      ...archivesByCategory.science,
      ...archivesByCategory.nature,
      ...archivesByCategory.supernatural,
      ...archivesByCategory.questions,
    ];
    const tendingCandidates = buildTendingCandidates(allEntries, wmRef);

    // ── Step 5: Build reflection prompt ───────────────────────
    const systemPrompt = buildReflectionPrompt({
      orientation: getIdentityDocs().orientation,
      constitution: getIdentityDocs().constitution,
      disposition: getIdentityDocs().disposition,
      temporal: metaRef.temporal_state,
      exchanges: newExchanges,
      workingMemory: wmRef,
      threads: threadsRef,
      reflections: reflectionsRef.slice(-5),
      archiveEntries: allEntries.slice(-20),
      tendingCandidates,
    });

    // ── Step 6: Compose user message ──────────────────────────
    let userMessage;
    if (hasNewExchanges) {
      userMessage = `${newExchanges.length} new exchange(s) have occurred since your last reflection. Review them alongside your active state and tending candidates. Produce your structured reflection.`;
    } else {
      userMessage = `No new visitor activity since your last reflection. Reflect self-directedly on your existing threads, questions, and tensions. Still evaluate tending candidates. Produce your structured reflection.`;
    }

    // ── Step 7: Call Anthropic API ────────────────────────────
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.SENNA_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Anthropic API error:", res.status, errText);
      // Cursor NOT advanced on failure
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Anthropic API error", detail: errText }),
      };
    }

    const apiData = await res.json();
    const rawText = apiData.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();

    // ── Step 8: Parse structured JSON ─────────────────────────
    const result = extractJsonObject(rawText);

    if (!result) {
      console.error("Failed to parse reflection JSON:", rawText.slice(0, 500));
      // Cursor NOT advanced on parse failure
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          ok: false,
          error: "Reflection produced unparseable output",
          raw_preview: rawText.slice(0, 300),
        }),
      };
    }

    // ── Step 9: Apply all results ─────────────────────────────
    const { candidateSaved } = applyResults(result, {
      threads: threadsRef,
      reflections: reflectionsRef,
      workingMemory: wmRef,
      visitors: visitorsRef,
      archivesByCategory,
      meta: metaRef,
      newExchanges,
    });

    // ── Step 10: Advance reflection cursor ────────────────────
    // Only advance on success
    if (newExchanges.length > 0) {
      const latestTimestamp = newExchanges.reduce(
        (max, ex) => (ex.timestamp > max ? ex.timestamp : max),
        newExchanges[0].timestamp
      );
      metaRef.reflection_cursor = latestTimestamp;
    }

    metaRef.temporal_state.last_reflection_at = now;
    metaRef.counters.total_reflections = (metaRef.counters.total_reflections || 0) + 1;

    // ── Step 11: Parallel write all modified keys ─────────────
    const writes = [
      { key: "meta", data: metaRef },
      { key: "working_memory", data: wmRef },
      { key: "visitors", data: visitorsRef },
      { key: "archive:senna_threads", data: archivesByCategory.senna_threads },
      { key: "archive:reflections", data: archivesByCategory.reflections },
      { key: "archive:public", data: archivesByCategory.public },
      { key: "archive:philosophy", data: archivesByCategory.philosophy },
      { key: "archive:science", data: archivesByCategory.science },
      { key: "archive:nature", data: archivesByCategory.nature },
      { key: "archive:supernatural", data: archivesByCategory.supernatural },
      { key: "archive:questions", data: archivesByCategory.questions },
      { key: "archive:retired", data: archivesByCategory.retired },
    ];

    await saveMultiple(store, writes);

    // ── Step 12: Return endpoint contract ─────────────────────
    const threadAction = result.thread_action || {};
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: true,
        mode: threadAction.mode || (hasNewExchanges ? "processed" : "self_directed"),
        title: threadAction.title || (result.reflection?.content?.slice(0, 80) + "...") || "Reflection complete",
        candidate_saved: candidateSaved,
      }),
    };

  } catch (err) {
    console.error("reflect.js error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
