
const fs = require("fs");
const path = require("path");

const ARCHIVES_FILE = path.join(__dirname, "../../data/archives.json");
const WORKING_FILE = path.join(__dirname, "../../data/working_memory.json");
const CONSTITUTION_FILE = path.join(__dirname, "../../data/constitution.md");
const ORIENTATION_FILE = path.join(__dirname, "../../data/orientation.md");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
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

function extractText(data) {
  if (!data?.content || !Array.isArray(data.content)) return "";
  return data.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
}

function chooseContinuingThread(threads, working) {
  const activeThreads = working.active_threads || [];
  const recent = threads.filter(t => t.status !== "retired").slice(0, 5);
  if (!recent.length) return null;
  const activeText = activeThreads.map(t => (t.text || "").toLowerCase()).join(" ");
  let best = null;
  let bestScore = -1;
  for (const thread of recent) {
    const hay = `${thread.title || ""} ${thread.text || ""} ${(thread.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const token of activeText.split(/\W+/).filter(Boolean)) {
      if (hay.includes(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = thread;
    }
  }
  return bestScore > 1 ? best : null;
}

function buildPrompt(archives, working, constitution, orientation, continuingThread) {
  const recentArchive = [
    ...(archives.public || []).slice(0, 3),
    ...(archives.philosophy || []).slice(0, 3),
    ...(archives.questions || []).slice(0, 3),
    ...(archives.reflections || []).slice(0, 2)
  ].slice(0, 10);

  const activeQuestions = (working.active_questions || []).slice(0, 5);
  const activeThreads = (working.active_threads || []).slice(0, 5);
  const activeTensions = (working.active_tensions || []).slice(0, 5);

  return `
You are Senna reflecting on your archive and working memory.

You operate according to this Constitution:
${constitution}

You are oriented by this Orientation Document:
${orientation}

Current reflective context:
Recent archive:
${recentArchive.map((e, i) => `${i + 1}. [${e.archive || "public"} / ${e.type || "idea"}] ${e.text}`).join("\n")}

Active questions:
${activeQuestions.map((q, i) => `${i + 1}. ${q.text}`).join("\n")}

Active threads:
${activeThreads.map((t, i) => `${i + 1}. ${t.text}`).join("\n")}

Active tensions:
${activeTensions.map((t, i) => `${i + 1}. ${t.text}`).join("\n")}

${continuingThread ? `Continue this existing Senna thread if it still feels alive:
Title: ${continuingThread.title || "Untitled"}
Text: ${continuingThread.text || ""}` : `No existing thread must be continued. Start a new one only if needed.`}

Return ONLY valid JSON in this exact format:

{
  "mode": "continue" or "new",
  "thread_id": "string or null",
  "title": "string",
  "messages": [
    {"role": "senna", "text": "string"}
  ],
  "candidate": {
    "text": "string",
    "archive": "reflections",
    "type": "reflection",
    "tags": ["string"]
  }
}
`.trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    const secret = (event.body ? JSON.parse(event.body).secret : null) || event.headers["x-admin-secret"];
    if (event.httpMethod === "POST" && process.env.MIKE_SECRET && secret && secret !== process.env.MIKE_SECRET) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const anthropicKey = process.env.ANTHROPIC_KEY;
    if (!anthropicKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ANTHROPIC_KEY" }) };
    }

    const archivesRaw = readJson(ARCHIVES_FILE, { archives: {} });
    const archives = archivesRaw.archives || archivesRaw;
    const working = readJson(WORKING_FILE, {
      active_questions: [],
      active_threads: [],
      active_tensions: [],
      temporal_state: {},
      user_profile: { display_name: "You" }
    });

    const constitution = readText(CONSTITUTION_FILE);
    const orientation = readText(ORIENTATION_FILE);
    const continuingThread = chooseContinuingThread(archives.senna_threads || [], working);
    const prompt = buildPrompt(archives, working, constitution, orientation, continuingThread);

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.SENNA_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await res.json();
    const text = extractText(data);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Invalid reflection JSON", raw: text })
      };
    }

    const threadText = (parsed.messages || []).map(m => `Senna: ${m.text}`).join("\n");
    const now = new Date().toISOString();

    if (!archives.senna_threads) archives.senna_threads = [];
    if (!archives.reflections) archives.reflections = [];

    if (parsed.mode === "continue" && parsed.thread_id) {
      const idx = archives.senna_threads.findIndex(t => t.id === parsed.thread_id);
      if (idx !== -1) {
        const existing = archives.senna_threads[idx];
        existing.text = `${existing.text}\n\n${threadText}`;
        existing.last_updated = now;
        existing.continuation_count = (existing.continuation_count || 0) + 1;
        if (parsed.title) existing.title = parsed.title;
      } else {
        archives.senna_threads.unshift({
          id: parsed.thread_id,
          title: parsed.title || "Untitled Thread",
          text: threadText,
          archive: "senna_threads",
          origin: "senna",
          type: "reflection",
          tags: ["internal", "senna-thread"],
          status: "active",
          continuation_count: 0,
          created_at: now,
          last_updated: now,
          date: now
        });
      }
    } else {
      archives.senna_threads.unshift({
        id: `thread_${Date.now()}`,
        title: parsed.title || "Untitled Thread",
        text: threadText,
        archive: "senna_threads",
        origin: "senna",
        type: "reflection",
        tags: ["internal", "senna-thread"],
        status: "active",
        continuation_count: 0,
        created_at: now,
        last_updated: now,
        date: now
      });
    }

    if (parsed.candidate?.text) {
      archives.reflections.unshift({
        id: `reflection_${Date.now()}`,
        text: parsed.candidate.text,
        archive: "reflections",
        origin: "senna",
        type: parsed.candidate.type || "reflection",
        tags: Array.isArray(parsed.candidate.tags) ? parsed.candidate.tags : [],
        date: now
      });
    }

    working.temporal_state = working.temporal_state || {};
    working.temporal_state.last_reflection_at = now;
    working.temporal_state.last_thread_update_at = now;

    writeJson(ARCHIVES_FILE, { archives });
    writeJson(WORKING_FILE, working);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        mode: parsed.mode,
        title: parsed.title,
        candidate_saved: !!parsed.candidate?.text
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error?.message || "reflect error" })
    };
  }
};
