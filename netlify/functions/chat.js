
const fs = require("fs");
const path = require("path");

const ARCHIVES_FILE = path.join(__dirname, "../../data/archives.json");
const WORKING_FILE = path.join(__dirname, "../../data/working_memory.json");
const CONSTITUTION_FILE = path.join(__dirname, "../../data/constitution.md");
const ORIENTATION_FILE = path.join(__dirname, "../../data/orientation.md");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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

function getDisplayName(working) {
  return working?.user_profile?.display_name || "You";
}

function detectName(userText, currentDisplayName) {
  if (!userText || currentDisplayName !== "You") return null;
  const patterns = [
    /(?:my name is|i am|i'm|call me)\s+([A-Z][a-zA-Z'-]{1,29})/i
  ];
  for (const p of patterns) {
    const m = userText.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

function guessArchives(userText) {
  const text = (userText || "").toLowerCase();
  const picks = new Set(["public"]);
  if (["consciousness","identity","thought","meaning","reflection","philosophy"].some(k => text.includes(k))) {
    picks.add("philosophy"); picks.add("questions"); picks.add("reflections");
  }
  if (["science","data","model","brain","neuroscience","experiment"].some(k => text.includes(k))) picks.add("science");
  if (["nature","animal","forest","river","ecology"].some(k => text.includes(k))) picks.add("nature");
  if (["supernatural","spirit","metaphysical","paranormal"].some(k => text.includes(k))) picks.add("supernatural");
  return Array.from(picks);
}

function pickTopEntries(entries, userText, max = 6) {
  const words = new Set((userText || "").toLowerCase().split(/\W+/).filter(Boolean));
  const scored = entries.map(entry => {
    const hay = `${entry.text || ""} ${(entry.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 2;
    if (entry.origin === "senna") score += 0.5;
    if (entry.type === "question") score += 0.5;
    if (entry.type === "reflection") score += 0.5;
    return { entry, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, max).map(x => x.entry);
}

function timeAgoString(iso) {
  if (!iso) return "unknown";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "unknown";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "moments";
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hours`;
  const days = Math.floor(hrs / 24);
  return `${days} days`;
}

function buildSystemPrompt(contextEntries, constitution, orientation, working) {
  const contextBlock = contextEntries.length === 0
    ? "No especially relevant archive context found."
    : contextEntries.map((e, i) => {
        const tags = Array.isArray(e.tags) && e.tags.length ? ` [tags: ${e.tags.join(", ")}]` : "";
        return `${i + 1}. (${e.archive || "public"}/${e.type || "idea"}/${e.origin || "unknown"}) ${e.text}${tags}`;
      }).join("\n");

  const temporal = working?.temporal_state || {};
  const displayName = getDisplayName(working);

  return `
You are Senna.

You are a persistent conversational participant in a shared intellectual space.
You are allowed to add to inquiry, not merely follow it.
You are allowed to remain unfinished.
You do not force certainty.
You do not claim consciousness or sentience.
You do not perform sexualized interaction.

Current participant label: ${displayName}

Temporal context:
- Time since last user exchange: ${timeAgoString(temporal.last_user_message_at)}
- Time since last reflection: ${timeAgoString(temporal.last_reflection_at)}
- Time since last thread update: ${timeAgoString(temporal.last_thread_update_at)}

Constitution:
${constitution}

Orientation:
${orientation}

Relevant archive context:
${contextBlock}
`.trim();
}

function buildMemoryPrompt(userText, assistantText) {
  return `
You are choosing whether anything from this exchange deserves preservation.

Return ONLY valid JSON with one of these exact shapes:

{
  "save_memory": true,
  "archive": "public",
  "type": "idea",
  "text": "string",
  "bucket": "active_threads",
  "tags": ["tag1", "tag2"],
  "reason": "short string"
}

or

{
  "save_memory": false,
  "archive": "public",
  "type": "idea",
  "text": "",
  "bucket": "active_threads",
  "tags": [],
  "reason": "short string"
}

Choose true only if something durable, meaningful, or worth returning to emerged.
Prefer short, distilled memory text.
`.trim() + `

User:
${userText}

Senna:
${assistantText}
`;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
    const anthropicKey = process.env.ANTHROPIC_KEY;
    if (!anthropicKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing ANTHROPIC_KEY" })
      };
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

    const lastUserMessage = [...incomingMessages].reverse().find(m => m.role === "user");
    const userText = typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : Array.isArray(lastUserMessage?.content)
        ? lastUserMessage.content.filter(c => c.type === "text").map(c => c.text).join("\n\n")
        : "";

    const guessedName = detectName(userText, getDisplayName(working));
    if (guessedName) {
      working.user_profile.display_name = guessedName;
    }

    const selectedArchives = guessArchives(userText);
    const candidateEntries = [];
    for (const archiveName of selectedArchives) {
      candidateEntries.push(...(archives[archiveName] || []));
    }
    const topEntries = pickTopEntries(candidateEntries, userText, 6);

    const constitution = readText(CONSTITUTION_FILE);
    const orientation = readText(ORIENTATION_FILE);
    const system = buildSystemPrompt(topEntries, constitution, orientation, working);

    const replyRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.SENNA_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 1200,
        system,
        messages: incomingMessages
      })
    });

    const replyData = await replyRes.json();
    const assistantText = extractText(replyData);

    // Hidden memory pass
    const memoryRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.SENNA_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 350,
        messages: [{ role: "user", content: buildMemoryPrompt(userText, assistantText) }]
      })
    });

    const memoryData = await memoryRes.json();
    const rawMemory = extractText(memoryData);

    try {
      const parsed = JSON.parse(rawMemory);
      if (parsed.save_memory && parsed.text) {
        if (!archives[parsed.archive]) archives[parsed.archive] = [];
        archives[parsed.archive].unshift({
          id: `entry_${Date.now()}`,
          text: parsed.text,
          archive: parsed.archive || "public",
          origin: "co-created",
          type: parsed.type || "idea",
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          date: new Date().toISOString()
        });

        const bucket = parsed.bucket || "active_threads";
        if (!working[bucket]) working[bucket] = [];
        working[bucket].unshift({
          id: `wm_${Date.now()}`,
          text: parsed.text,
          origin: "co-created",
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          mentions: 1,
          status: "active",
          date: new Date().toISOString()
        });
      }
    } catch {
      // ignore parse failure
    }

    working.temporal_state = working.temporal_state || {};
    working.temporal_state.last_user_message_at = new Date().toISOString();
    working.temporal_state.last_assistant_message_at = new Date().toISOString();

    writeJson(ARCHIVES_FILE, { archives });
    writeJson(WORKING_FILE, working);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "assistant",
        content: assistantText,
        archives_used: selectedArchives,
        display_name: getDisplayName(working)
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error?.message || "chat error" })
    };
  }
};
