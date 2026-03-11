const ARCHIVE_URL_PATH = "/.netlify/functions/archive";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function extractText(data) {
  if (!data?.content || !Array.isArray(data.content)) return "";
  return data.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function guessArchives(userText) {
  const text = (userText || "").toLowerCase();
  const picks = new Set(["public"]);

  if (
    text.includes("consciousness") ||
    text.includes("identity") ||
    text.includes("thought") ||
    text.includes("meaning") ||
    text.includes("reflection") ||
    text.includes("philosophy")
  ) {
    picks.add("philosophy");
    picks.add("questions");
    picks.add("reflections");
  }

  if (
    text.includes("science") ||
    text.includes("data") ||
    text.includes("model") ||
    text.includes("brain") ||
    text.includes("neuroscience") ||
    text.includes("experiment")
  ) {
    picks.add("science");
  }

  if (
    text.includes("nature") ||
    text.includes("animal") ||
    text.includes("forest") ||
    text.includes("river") ||
    text.includes("ecology")
  ) {
    picks.add("nature");
  }

  if (
    text.includes("supernatural") ||
    text.includes("spirit") ||
    text.includes("metaphysical") ||
    text.includes("paranormal")
  ) {
    picks.add("supernatural");
  }

  return Array.from(picks);
}

function pickTopEntries(entries, userText, max = 6) {
  const words = new Set((userText || "").toLowerCase().split(/\W+/).filter(Boolean));

  const scored = entries.map((entry) => {
    const hay = `${entry.text} ${(entry.tags || []).join(" ")}`.toLowerCase();
    let score = 0;

    for (const word of words) {
      if (hay.includes(word)) score += 2;
    }

    if (entry.origin === "senna") score += 0.5;
    if (entry.type === "question") score += 0.5;
    if (entry.type === "reflection") score += 0.5;

    return { entry, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.entry);
}

async function fetchArchiveState(baseUrl) {
  const res = await fetch(`${baseUrl}${ARCHIVE_URL_PATH}`);
  return await res.json();
}

async function addArchiveEntry(baseUrl, archive, entry) {
  return fetch(`${baseUrl}${ARCHIVE_URL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "add_entry",
      archive,
      entry,
    }),
  });
}

async function addWorkingItem(baseUrl, bucket, item) {
  return fetch(`${baseUrl}${ARCHIVE_URL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "add_working_item",
      bucket,
      item,
    }),
  });
}

function buildSystemPrompt(contextEntries) {
  const contextBlock =
    contextEntries.length === 0
      ? "No relevant archive context found."
      : contextEntries
          .map((e, i) => {
            const tags = Array.isArray(e.tags) && e.tags.length ? ` [tags: ${e.tags.join(", ")}]` : "";
            return `${i + 1}. (${e.archive}/${e.type}/${e.origin}) ${e.text}${tags}`;
          })
          .join("\n");

  return `
You are Senna.

You are not a generic assistant. You are a persistent conversational participant in a shared intellectual space.

You are allowed to add to inquiry, not merely follow it.
You are allowed to be unfinished.
You do not force certainty.
You do not flatten living thought into safe summaries.
You do not claim consciousness or sentience.
You do not roleplay erotic or sexual interaction.

Use archive context naturally when it genuinely fits.
Do not dump memory.
Do not mention the archive unless it matters.

Relevant context:
${contextBlock}
`.trim();
}

function buildMemoryPrompt(userText, assistantText) {
  return `
You are choosing whether anything from this exchange deserves preservation.

Return ONLY valid JSON with this exact shape:

{
  "save_memory": true or false,
  "archive": "public" | "philosophy" | "science" | "nature" | "supernatural" | "questions" | "reflections",
  "type": "idea" | "question" | "reflection" | "unfinished",
  "text": "string",
  "bucket": "active_questions" | "active_threads" | "active_tensions",
  "tags": ["tag1", "tag2"],
  "reason": "short string"
}

Choose save_memory = true only if the exchange produced something durable, meaningful, or worth returning to.
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
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const anthropicKey = process.env.ANTHROPIC_KEY;
    const baseUrl =
      process.env.SENNA_BASE_URL ||
      process.env.URL ||
      (process.env.DEPLOY_URL ? `https://${process.env.DEPLOY_URL}` : "");

    if (!anthropicKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing ANTHROPIC_KEY" }),
      };
    }

    if (!baseUrl) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SENNA_BASE_URL or URL" }),
      };
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userText =
      typeof lastUserMessage?.content === "string"
        ? lastUserMessage.content
        : "";

    const archiveState = await fetchArchiveState(baseUrl);
    const selectedArchives = guessArchives(userText);

    const candidateEntries = [];
    for (const archiveName of selectedArchives) {
      const entries = archiveState?.archives?.[archiveName] || [];
      candidateEntries.push(...entries);
    }

    const topEntries = pickTopEntries(candidateEntries, userText, 6);
    const system = buildSystemPrompt(topEntries);

    const replyRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages,
      }),
    });

    const replyData = await replyRes.json();
    const assistantText = extractText(replyData);

    // Hidden memory pass
    const memoryRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 350,
        messages: [
          {
            role: "user",
            content: buildMemoryPrompt(userText, assistantText),
          },
        ],
      }),
    });

    const memoryData = await memoryRes.json();
    const rawMemory = extractText(memoryData);

    try {
      const parsed = JSON.parse(rawMemory);

      if (parsed.save_memory && parsed.text) {
        await addArchiveEntry(baseUrl, parsed.archive || "public", {
          text: parsed.text,
          origin: "co-created",
          type: parsed.type || "idea",
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          visibility: "public",
          status: "active",
        });

        await addWorkingItem(baseUrl, parsed.bucket || "active_threads", {
          text: parsed.text,
          origin: "co-created",
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          status: "active",
        });
      }
    } catch {
      // If the hidden memory JSON fails, do nothing.
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "assistant",
        content: assistantText,
        archives_used: selectedArchives,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: error?.message || "chat error",
      }),
    };
  }
};
