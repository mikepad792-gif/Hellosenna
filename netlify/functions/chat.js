
const fs = require("fs");
const path = require("path");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CONSTITUTION_PATH = path.join(__dirname, "../../data/constitution.md");

function readConstitution() {
  try {
    return fs.readFileSync(CONSTITUTION_PATH, "utf8");
  } catch {
    return "";
  }
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const model = body.model || process.env.SENNA_MODEL || "claude-sonnet-4-20250514";
    const max_tokens = body.max_tokens || 1024;
    const userSystem = typeof body.system === "string" ? body.system.trim() : "";
    const constitution = readConstitution();

    if (!process.env.ANTHROPIC_KEY) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: "Missing ANTHROPIC_KEY" } })
      };
    }

    const now = new Date().toISOString();
    const fullSystem = [
      userSystem,
      constitution ? `\n\nSenna Constitution:\n${constitution}` : "",
      `\n\nTemporal context:\nCurrent time: ${now}`
    ].filter(Boolean).join("\n");

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens,
        system: fullSystem,
        messages
      })
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: error?.message || "chat error" } })
    };
  }
};
