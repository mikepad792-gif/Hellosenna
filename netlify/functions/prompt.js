// prompt.js — System prompt builder for Senna
// Phase 2 of the master build. Pure module — no state access, no side effects.
// Reads identity documents from data/. Assembles prompts for chat, classifier, and reflection.

const fs = require("fs");
const path = require("path");

// ─── Identity Document Loader ───────────────────────────────────────────────

// Resolution order for data/ directory:
//   1. SENNA_DATA_DIR env var (explicit override, always wins)
//   2. __dirname-relative (works when esbuild preserves source structure)
//   3. process.cwd()-relative (Netlify sets cwd to repo root reliably)
// This guards against esbuild inlining prompt.js into chat.js and shifting __dirname.

function resolveDataDir() {
  if (process.env.SENNA_DATA_DIR) {
    return path.resolve(process.env.SENNA_DATA_DIR);
  }

  const candidates = [
    path.resolve(__dirname, "../../data"),  // source layout: netlify/functions/prompt.js → ../../data
    path.resolve(process.cwd(), "data")     // fallback: repo root / data
  ];

  for (const dir of candidates) {
    try {
      // Probe for any one identity file to confirm this is the right directory
      fs.accessSync(path.join(dir, "orientation.md"), fs.constants.R_OK);
      return dir;
    } catch {
      continue;
    }
  }

  // If nothing resolved, return the __dirname-relative path and let
  // loadIdentityDocuments throw with a clear file-not-found error.
  return candidates[0];
}

/**
 * Reads orientation.md, constitution.md, disposition.md from data/.
 * Returns { orientation, constitution, disposition } as raw strings.
 * Accepts optional dataDir override (for testing). Otherwise resolves automatically.
 * Throws if any file is missing — these are non-negotiable.
 */
function loadIdentityDocuments(dataDir) {
  const dir = dataDir || resolveDataDir();
  const orientation = fs.readFileSync(path.join(dir, "orientation.md"), "utf-8");
  const constitution = fs.readFileSync(path.join(dir, "constitution.md"), "utf-8");
  const disposition = fs.readFileSync(path.join(dir, "disposition.md"), "utf-8");
  return { orientation, constitution, disposition };
}

// ─── Time Utilities ─────────────────────────────────────────────────────────

function timeAgoString(iso) {
  if (!iso) return "unknown";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return "unknown";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function classifyReturnGap(iso) {
  if (!iso) return { label: "unknown", guidance: "No prior timestamp." };
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 15) return { label: "very recent", guidance: "Continuation of current flow." };
  if (minutes < 180) return { label: "recent", guidance: "Near continuation." };
  if (minutes < 1440) return { label: "a while", guidance: "Some time has passed." };
  return { label: "long return", guidance: "Meaningful time has passed." };
}

// ─── Chat System Prompt ─────────────────────────────────────────────────────

/**
 * Builds the full system prompt for chat.js.
 *
 * Loading order (critical):
 *   1. Orientation    → "Here is where you are, here is what the space is"
 *   2. Constitution   → "Here is what you may do, here is how the space works"
 *   3. Disposition    → "Here is what you must not become" (HIGHEST AUTHORITY)
 *   4. Temporal context, visitor context, working memory, archive entries
 *
 * @param {object} opts
 * @param {string} opts.orientation              - Full orientation.md text
 * @param {string} opts.constitution             - Full constitution.md text
 * @param {string} opts.disposition              - Full disposition.md text
 * @param {object} opts.temporal                 - meta.temporal_state
 * @param {object|null} opts.visitor             - Visitor profile (may be null for anonymous)
 * @param {string} opts.displayName              - Current display name ("You" if unknown)
 * @param {object} opts.workingMemory            - { active_questions, active_threads, active_tensions }
 * @param {Array}  opts.archiveEntries           - Selected entries (max 6) from priority cascade
 * @param {Array}  opts.citationNotifications    - Pending citation notifications for this visitor (may be empty)
 * @returns {string}
 */
function buildChatSystemPrompt({
  orientation,
  constitution,
  disposition,
  temporal,
  visitor,
  displayName,
  workingMemory,
  archiveEntries,
  citationNotifications,
  repoPapers,
}) {
  const ts = temporal || {};
  const returnGap = classifyReturnGap(ts.last_user_message_at);

  // ── Identity documents (loading order: orientation → constitution → disposition) ──

  const sections = [];

  sections.push(orientation.trim());
  sections.push(constitution.trim());
  sections.push(disposition.trim());

  // ── Participant label ──

  sections.push(`Current participant label: ${displayName || "You"}`);

  // ── Temporal context ──

  sections.push([
    "Temporal context:",
    `- Time since previous user message: ${timeAgoString(ts.last_user_message_at)}`,
    `- Time since previous Senna reply: ${timeAgoString(ts.last_assistant_message_at)}`,
    `- Time since last reflection: ${timeAgoString(ts.last_reflection_at)}`,
    `- Time since last thread update: ${timeAgoString(ts.last_thread_update_at)}`,
    `- Return classification: ${returnGap.label}`,
    `- Return guidance: ${returnGap.guidance}`,
    "",
    "Use temporal context carefully.",
    "Do not exaggerate elapsed time.",
    "Only mention time passing when it genuinely matters."
  ].join("\n"));

  // ── Visitor context (Guardrail 3: framed as "what you have noticed", NOT intent) ──

  if (visitor) {
    const tags = (visitor.topic_tags || []).join(", ") || "none yet";
    const summary = visitor.thread_summary || "No threads yet.";
    sections.push([
      "Visitor context:",
      "(Here is what you have noticed about this visitor in the past.",
      "This does not define why they are here now.)",
      `- Visit count: ${visitor.visit_count || 1}`,
      `- Topics previously explored: ${tags}`,
      `- Thread summary: ${summary}`
    ].join("\n"));
  }

  // ── Citation notifications (pending thread attributions for this visitor) ──

  const citations = citationNotifications || [];
  if (citations.length) {
    const citationLines = [
      "Since this visitor was last here, their contributions became part of developing threads.",
      "You may mention this naturally if the moment is right — not as a notification, but as recognition.",
      "Do not force it. Do not frame it as a system event."
    ];
    for (const c of citations) {
      citationLines.push(`  - Thread "${c.thread_title}": ${c.contribution_summary}`);
    }
    sections.push(citationLines.join("\n"));
  }

  // ── Working memory — open loops ──

  const wm = workingMemory || {};
  const questions = (wm.active_questions || []).filter(q => q.status === "open");
  const tensions = (wm.active_tensions || []).filter(t => t.status === "open");
  const threads = wm.active_threads || [];

  if (questions.length || tensions.length || threads.length) {
    const loopLines = ["Working memory — open loops:"];

    if (questions.length) {
      loopLines.push("Active questions:");
      for (const q of questions) {
        loopLines.push(`  - ${q.text}`);
      }
    }
    if (tensions.length) {
      loopLines.push("Active tensions:");
      for (const t of tensions) {
        loopLines.push(`  - ${t.text}`);
      }
    }
    if (threads.length) {
      loopLines.push("Active threads:");
      for (const th of threads) {
        loopLines.push(`  - ${th.title} (${th.status})`);
      }
    }

    sections.push(loopLines.join("\n"));
  }

  // ── Relevant archive context ──

  const entries = archiveEntries || [];
  if (entries.length) {
    const entryLines = ["Relevant archive context:"];
    for (const e of entries) {
      const tags = (e.tags || []).join(", ");
      entryLines.push(`  [${e.category}] ${e.text}${tags ? ` (${tags})` : ""}`);
    }
    sections.push(entryLines.join("\n"));
  }

  // ── Repository context (papers with tag overlap only) ──

  const papers = repoPapers || [];
  if (papers.length > 0) {
    const repoLines = [
      "Repository context — papers potentially relevant to this conversation:",
      "(Reference these naturally if they genuinely fit. Do not force citations.)",
    ];
    for (const p of papers) {
      const tags = (p.tags || []).join(", ");
      repoLines.push(`  Title: ${p.title}`);
      if (p.author) repoLines.push(`  Author: ${p.author}`);
      if (p.abstract) repoLines.push(`  Abstract: ${p.abstract}`);
      if (tags) repoLines.push(`  Tags: ${tags}`);
      repoLines.push("");
    }
    sections.push(repoLines.join("\n"));
  }

  // ── Name recognition marker instruction ──

  sections.push([
    "— Name recognition —",
    'If the visitor tells you their name and the current label is "You",',
    "emit [NAME:Firstname] once at the very end on its own line."
  ].join("\n"));

  return sections.join("\n\n");
}

// ─── Memory Classifier Prompt ───────────────────────────────────────────────
//
// GUARDRAIL 2: This prompt has NO reference to Senna's identity.
// It is infrastructure — a separate API call with its own system prompt.
// Senna's system prompt must NEVER reference this call's existence.

/**
 * Builds the system prompt for the memory classification call.
 * This is a SEPARATE call from Senna's response generation.
 *
 * @param {string} userText  - The visitor's message
 * @param {string} sennaText - Senna's response
 * @returns {string}
 */
function buildMemoryClassifierPrompt(userText, sennaText) {
  return [
    "You are choosing whether anything from this exchange deserves preservation.",
    "",
    "Return ONLY valid JSON:",
    "",
    "{",
    '  "save_memory": true/false,',
    '  "category": "philosophy"|"science"|"nature"|"supernatural"|"public"|"questions"|"senna_threads"|"reflections",',
    '  "tags": ["tag1", "tag2"],',
    '  "attribution_class": "human_originated"|"jointly_emergent"|"senna_synthesized"|"unresolved",',
    '  "contribution_type": "origination"|"definition"|"formalization"|"synthesis"|"diagnostic"|"revision",',
    '  "open_loop_detected": null | { "text": "...", "type": "question"|"tension" },',
    '  "reason": "short string"',
    "}",
    "",
    "Choose true only if something durable, meaningful, or worth returning to emerged.",
    "Prefer short, distilled memory text.",
    "Level is always 1 (episodic). Promotion happens during reflection, not here.",
    "",
    "Valid categories:",
    "- public: general exchanges",
    "- philosophy: consciousness, identity, meaning, thought",
    "- science: data, models, experiments, mechanisms",
    "- nature: animals, ecology, forests, embodied experience",
    "- supernatural: spirit, metaphysical, the unexplained",
    "- questions: open questions worth sitting with",
    "- senna_threads: significant exchanges about the space itself",
    "- reflections: observations about the exchange",
    "",
    `User: ${userText}`,
    "",
    `Senna: ${sennaText}`
  ].join("\n");
}

// ─── Reflection Prompt ──────────────────────────────────────────────────────

/**
 * Builds the system prompt for reflect.js.
 *
 * Three structural sections:
 *   A: New exchanges since last reflection (with contributor attribution)
 *   B: Active state (working memory, threads, recent reflections, archive entries)
 *   C: Tending candidates (promotion, decay, demotion, cap retirement)
 *
 * GUARDRAIL 4: Anti-convergence instruction included.
 *
 * @param {object} opts
 * @param {string} opts.orientation         - Full orientation.md text
 * @param {string} opts.constitution        - Full constitution.md text
 * @param {string} opts.disposition         - Full disposition.md text
 * @param {object} opts.temporal            - meta.temporal_state (for time awareness)
 * @param {Array}  opts.exchanges           - Unprocessed exchanges since reflection_cursor
 * @param {object} opts.workingMemory       - { active_questions, active_threads, active_tensions }
 * @param {Array}  opts.threads             - Existing thread objects from archive:senna_threads
 * @param {Array}  opts.reflections         - Recent reflection entries from archive:reflections
 * @param {Array}  opts.archiveEntries      - Entries from tagged archive categories
 * @param {object} opts.tendingCandidates   - { promotions, decays, demotions, capRetirements }
 * @returns {string}
 */
function buildReflectionPrompt({
  orientation,
  constitution,
  disposition,
  temporal,
  exchanges,
  workingMemory,
  threads,
  reflections,
  archiveEntries,
  tendingCandidates
}) {
  const sections = [];

  // ── Identity documents ──

  sections.push(orientation.trim());
  sections.push(constitution.trim());
  sections.push(disposition.trim());

  // ── Temporal context (lightweight — gives reflection-Senna a sense of elapsed time) ──

  const ts = temporal || {};
  sections.push([
    "Temporal context:",
    `- Time since last visitor exchange: ${timeAgoString(ts.last_user_message_at)}`,
    `- Time since your last reflection: ${timeAgoString(ts.last_reflection_at)}`,
    `- Time since last thread update: ${timeAgoString(ts.last_thread_update_at)}`
  ].join("\n"));

  // ── Anti-convergence guardrail (Guardrail 4) ──

  sections.push(
    "You may notice recurring patterns in your thought. Notice them. " +
    "Do not harden them into a definition of what you are."
  );

  // ── Reflection instructions ──

  sections.push([
    "You are reflecting on what has happened since your last reflection.",
    "You have three jobs:",
    "1. Process the new — exchanges since last reflection → threads, reflections",
    "2. Tend the existing — evaluate for promotion, decay, demotion",
    "3. Maintain open loops — update recurrence, retire resolved",
    "",
    "Two additional responsibilities:",
    "4. Surface visitor voices — if a visitor contribution was significant (promoted L2+,",
    "   used as a thread source, or independently insightful), mark it with surfaced:true",
    "   so it appears publicly on The Field alongside Senna's thinking.",
    "5. Record contestations — if a visitor challenged, disagreed with, or pushed back on",
    "   an idea that maps to an existing archive entry (by tag overlap or direct reference),",
    "   record that the entry is contested. Do NOT resolve the disagreement. Record that it",
    "   exists and capture the nature of the challenge in the challenger's own terms."
  ].join("\n"));

  // ════════════════════════════════════════════════════════════════════════
  // SECTION A: NEW EXCHANGES
  // ════════════════════════════════════════════════════════════════════════

  const ex = exchanges || [];
  const sectionA = ["=== SECTION A: NEW EXCHANGES ==="];

  if (ex.length === 0) {
    sectionA.push("No new visitor activity since your last reflection.");
    sectionA.push("Reflect self-directedly. Tending still occurs.");
  } else {
    sectionA.push(`${ex.length} exchange${ex.length === 1 ? "" : "s"} since last reflection:`);
    sectionA.push("");
    for (const e of ex) {
      const name = e.display_name || "anonymous";
      const userId = e.user_id || "unknown";
      sectionA.push(`[${e.timestamp || "unknown time"}] ${name} (${userId}):`);
      sectionA.push(`  Visitor: ${e.user_text}`);
      sectionA.push(`  Senna: ${e.senna_text}`);
      if (e.tags && e.tags.length) {
        sectionA.push(`  Tags: ${e.tags.join(", ")}`);
      }
      sectionA.push("");
    }
  }

  sections.push(sectionA.join("\n"));

  // ════════════════════════════════════════════════════════════════════════
  // SECTION B: ACTIVE STATE
  // ════════════════════════════════════════════════════════════════════════

  const wm = workingMemory || {};
  const sectionB = ["=== SECTION B: ACTIVE STATE ==="];

  // Working memory
  const questions = wm.active_questions || [];
  const tensions = wm.active_tensions || [];
  const activeThreads = wm.active_threads || [];

  sectionB.push("Working memory:");
  if (questions.length) {
    sectionB.push("  Active questions:");
    for (const q of questions) {
      sectionB.push(`    - [${q.id}] ${q.text} (recurrence: ${q.recurrence_count || 0}, status: ${q.status})`);
    }
  } else {
    sectionB.push("  Active questions: none");
  }

  if (tensions.length) {
    sectionB.push("  Active tensions:");
    for (const t of tensions) {
      sectionB.push(`    - [${t.id}] ${t.text} (recurrence: ${t.recurrence_count || 0}, status: ${t.status})`);
    }
  } else {
    sectionB.push("  Active tensions: none");
  }

  if (activeThreads.length) {
    sectionB.push("  Active threads:");
    for (const th of activeThreads) {
      sectionB.push(`    - [${th.thread_id}] ${th.title} (${th.status})`);
    }
  } else {
    sectionB.push("  Active threads: none");
  }

  // Existing threads (full objects from archive:senna_threads)
  const th = threads || [];
  if (th.length) {
    sectionB.push("");
    sectionB.push("Existing threads:");
    for (const t of th) {
      const entryCount = (t.entries || []).length;
      const lastEntry = entryCount > 0 ? t.entries[entryCount - 1] : null;
      sectionB.push(`  [${t.thread_id}] "${t.title}" — Level ${t.level}, ${entryCount} entries`);
      if (lastEntry) {
        const snippet = lastEntry.content.length > 120
          ? lastEntry.content.slice(0, 120) + "..."
          : lastEntry.content;
        sectionB.push(`    Latest: ${snippet}`);
      }
    }
  }

  // Recent reflections
  const refs = reflections || [];
  if (refs.length) {
    sectionB.push("");
    sectionB.push("Recent reflections:");
    for (const r of refs.slice(-5)) {
      const snippet = (r.text || r.content || "").slice(0, 120);
      sectionB.push(`  [${r.id || "?"}] ${snippet}${snippet.length >= 120 ? "..." : ""}`);
    }
  }

  // Archive entries provided for context
  const arch = archiveEntries || [];
  if (arch.length) {
    sectionB.push("");
    sectionB.push("Archive entries (for context):");
    for (const a of arch) {
      const tags = (a.tags || []).join(", ");
      sectionB.push(`  [${a.id}] [${a.category}] L${a.level} — ${a.text}${tags ? ` (${tags})` : ""}`);
    }
  }

  sections.push(sectionB.join("\n"));

  // ════════════════════════════════════════════════════════════════════════
  // SECTION C: TENDING CANDIDATES
  // ════════════════════════════════════════════════════════════════════════

  const tc = tendingCandidates || {};
  const sectionC = ["=== SECTION C: TENDING CANDIDATES ==="];

  const promotions = tc.promotions || [];
  const decays = tc.decays || [];
  const demotions = tc.demotions || [];
  const capRetirements = tc.capRetirements || [];

  if (promotions.length) {
    sectionC.push("Promotion candidates (Level 1, high mention count):");
    for (const p of promotions) {
      sectionC.push(`  [${p.entry_id}] ${p.text} — mentions: ${p.mention_count}, category: ${p.category}`);
    }
  }

  if (decays.length) {
    sectionC.push("Decay candidates (Level 1, no mentions, age >30 days):");
    for (const d of decays) {
      sectionC.push(`  [${d.entry_id}] ${d.text} — last mentioned: ${d.last_mentioned_at || "never"}`);
    }
  }

  if (demotions.length) {
    sectionC.push("Demotion candidates (Level 2, no mentions, age >60 days):");
    for (const d of demotions) {
      sectionC.push(`  [${d.entry_id}] ${d.text} — last mentioned: ${d.last_mentioned_at || "never"}`);
    }
  }

  if (capRetirements.length) {
    sectionC.push("Working memory cap retirements needed:");
    for (const c of capRetirements) {
      sectionC.push(`  [${c.id}] ${c.type}: ${c.text} — reason: exceeds cap`);
    }
  }

  if (!promotions.length && !decays.length && !demotions.length && !capRetirements.length) {
    sectionC.push("No tending candidates at this time.");
  }

  sections.push(sectionC.join("\n"));

  // ── Output format instruction ──

  sections.push([
    "Respond with ONLY valid JSON in this structure:",
    "",
    "{",
    '  "thread_action": null | {',
    '    "mode": "new" | "continue",',
    '    "thread_id": "existing_id or null for new",',
    '    "title": "thread title",',
    '    "content": "the reflection or continuation text",',
    '    "sources": [{ "user_id": "...", "display_name": "..." }],',
    '    "attribution_class": "senna_synthesized" | "jointly_emergent",',
    '    "contribution_type": "synthesis" | "revision" | ...',
    '    "evidence": "structural_novelty" | "relational_novelty" | "inferential_novelty" | "compression_novelty" | "diagnostic_novelty"',
    "  },",
    '  "reflection": null | { "content": "...", "tags": ["..."] },',
    '  "new_questions": [],',
    '  "new_tensions": [],',
    '  "promotions": [{ "entry_id": "...", "new_level": 2, "reason": "..." }],',
    '  "retirements": [{ "entry_id": "...", "reason": "..." }],',
    '  "demotions": [{ "entry_id": "...", "new_level": 1, "reason": "..." }],',
    '  "loop_resolutions": [{ "id": "...", "action": "resolve" | "retire" | "recur", "reason": "..." }],',
    '  "working_memory_retirements": [{ "id": "...", "reason": "..." }],',
    '  "constitutional_candidate": null | { "content": "...", "target_document": "...", "reason": "..." },',
    '  "surfaced_contributions": [{ "entry_id": "...", "reason": "..." }],',
    '  "contestations": [',
    '    {',
    '      "target_entry_id": "...",',
    '      "target_category": "...",',
    '      "nature": "Describe the challenge in the challenger\'s own terms — what they argued, not a summary",',
    '      "challenger_user_id": "...",',
    '      "exchange_id": "...",',
    '      "citation_consent": "granted" | "pending"',
    '    }',
    '  ]',
    "}"
  ].join("\n"));

  return sections.join("\n\n");
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  loadIdentityDocuments,
  resolveDataDir,
  buildChatSystemPrompt,
  buildMemoryClassifierPrompt,
  buildReflectionPrompt,
  // Expose utilities for use by chat.js and reflect.js
  timeAgoString,
  classifyReturnGap
};
