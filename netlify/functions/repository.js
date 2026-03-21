// ─────────────────────────────────────────────────────────────
// repository.js — Senna Repository Backend
// Netlify Function · Store: senna-repository
// ─────────────────────────────────────────────────────────────

const { getStore, connectLambda } = require("@netlify/blobs");

// Ensure fetch works in all Node runtimes (Node 16/17 lack global fetch)
const fetch = global.fetch || require("node-fetch");

// ── Config ──────────────────────────────────────────────────

const STORE_NAME = "senna-repository";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const repoApiKey =
  process.env.REPOSITORY_API_KEY || process.env.ANTHROPIC_KEY;
const MIKE_SECRET = process.env.MIKE_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENNA_MODEL = process.env.SENNA_MODEL || "claude-sonnet-4-20250514";
const DOMAIN = "https://hellosenna.world";

// ── Helpers ─────────────────────────────────────────────────

function ok(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function err(statusCode, message, extra = {}) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ ok: false, message, ...extra }),
  };
}

function generateId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}${rand}`;
}

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "atok_";
  for (let i = 0; i < 40; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

function now() {
  return new Date().toISOString();
}

function snippetize(text, len = 200) {
  if (!text) return "";
  return text.length <= len ? text : text.slice(0, len).trim() + "…";
}

/** Word-level similarity: shared words / max words. */
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wordsB = b.toLowerCase().split(/\s+/).filter(Boolean);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let shared = 0;
  for (const w of setA) {
    if (setB.has(w)) shared++;
  }
  const maxLen = Math.max(setA.size, setB.size);
  return maxLen === 0 ? 1 : shared / maxLen;
}

/** Basic sentence-check: has periods and word count > 10. */
function looksLikeSentences(text) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasPeriods = /\./.test(text);
  return wordCount > 10 && hasPeriods;
}

// ── Store Access ────────────────────────────────────────────

function connectStore(event) {
  connectLambda(event);
  return getStore(STORE_NAME);
}

async function getJSON(store, key) {
  try {
    const raw = await store.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putJSON(store, key, data) {
  await store.set(key, JSON.stringify(data));
}

// ── Coherence Check (Part 8.1) ──────────────────────────────

function coherenceCheck({ title, abstract, tags, external_link, pdf_data }) {
  const errors = [];

  if (!title || title.trim().length < 5) {
    errors.push("Title must be at least 5 characters.");
  }
  if (!abstract || abstract.trim().length < 50) {
    errors.push("Abstract must be at least 50 characters.");
  }
  if (abstract && abstract.trim().length > 3000) {
    errors.push("Abstract must be 3000 characters or fewer.");
  }
  if (abstract && abstract.trim().length >= 50 && !looksLikeSentences(abstract)) {
    errors.push("Abstract must contain actual sentences (word count > 10 with punctuation).");
  }
  if (!tags || !Array.isArray(tags) || tags.filter(Boolean).length === 0) {
    errors.push("At least one tag is required.");
  }
  if (!external_link && !pdf_data) {
    errors.push("Either an external link or a PDF upload is required.");
  }

  return { passed: errors.length === 0, errors };
}

// ── Duplicate Detection (Part 8.2) ──────────────────────────

async function duplicateDetection(newTitle, newAbstract, existingPapers) {
  // Skip if no existing papers or no API key
  if (!existingPapers || existingPapers.length === 0) {
    return { checked: true, duplicates_found: false, matches: [] };
  }
  if (!repoApiKey) {
    console.warn("No API key for duplicate detection — skipping.");
    return { checked: false, duplicates_found: false, matches: [] };
  }

  const existingList = existingPapers
    .map(
      (p, i) =>
        `${i + 1}. [${p.paper_id}] "${p.title}" — "${snippetize(p.abstract_snippet || "", 500)}"`
    )
    .join("\n");

  const systemPrompt = `You are reviewing a research paper submission for duplicate detection.
Compare the new submission against existing papers in the repository.
Return ONLY valid JSON:
{
  "duplicates_found": true/false,
  "matches": [
    {
      "paper_id": "paper_001",
      "title": "Existing paper title",
      "similarity": "high" | "moderate",
      "reason": "Both papers argue that..."
    }
  ]
}
Only flag as duplicate if the core argument or thesis substantially overlaps.
Same topic with different claims is NOT a duplicate.
Same methodology applied to different questions is NOT a duplicate.`;

  const userMessage = `New submission:\nTitle: ${newTitle}\nAbstract: ${newAbstract}\n\nExisting papers:\n${existingList}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": repoApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SENNA_MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!resp.ok) {
      console.error("Duplicate detection API error:", resp.status);
      return { checked: false, duplicates_found: false, matches: [] };
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Strip markdown fences if present
    const clean = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error("Duplicate detection: model returned unparseable JSON:", clean.slice(0, 200));
      return { checked: false, duplicates_found: false, matches: [] };
    }

    return {
      checked: true,
      duplicates_found: !!parsed.duplicates_found,
      matches: parsed.matches || [],
    };
  } catch (e) {
    console.error("Duplicate detection failed:", e.message);
    return { checked: false, duplicates_found: false, matches: [] };
  }
}

// ── Email (Magic Link via Resend) ───────────────────────────

async function sendMagicLinkEmail(email, authorToken) {
  if (!RESEND_API_KEY) {
    console.warn("No RESEND_API_KEY — magic link email skipped.");
    return false;
  }

  const link = `${DOMAIN}/repository.html?auth=${authorToken}`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Senna Repository <repository@hellosenna.world>",
        to: [email],
        subject: "Your Senna Repository Access",
        text: `You submitted a paper to hellosenna.world/repository.\n\nAccess your papers and submission status:\n${link}\n\nThis link is your permanent access token. Bookmark it or save this email.`,
      }),
    });

    return resp.ok;
  } catch (e) {
    console.error("Email send failed:", e.message);
    return false;
  }
}

// ── Minor / Major Classification (Part 11.3) ────────────────

function classifyEdit(oldVersion, newData) {
  const reasons = [];

  // Abstract similarity
  if (newData.abstract && oldVersion.abstract) {
    const sim = textSimilarity(newData.abstract, oldVersion.abstract);
    if (sim < 0.8) {
      reasons.push("abstract_changed");
    }
  }

  // Title similarity
  if (newData.title && oldVersion.title) {
    const sim = textSimilarity(newData.title, oldVersion.title);
    if (sim < 0.8) {
      reasons.push("title_changed");
    }
  }

  // New PDF
  if (newData.pdf_data) {
    reasons.push("new_pdf");
  }

  return reasons.length > 0 ? "major" : "minor";
}

// ── GET Handler ─────────────────────────────────────────────

async function handleGet(event) {
  const params = event.queryStringParameters || {};
  const store = connectStore(event);

  // Individual paper: ?paper=paper_001
  if (params.paper) {
    const paper = await getJSON(store, `paper:${params.paper}`);
    if (!paper) return err(404, "Paper not found.");

    // Return current version merged with metadata
    const current = paper.versions[paper.current_version - 1] || paper.versions[paper.versions.length - 1];
    return ok({
      paper_id: paper.paper_id,
      author_name: paper.author_name,
      affiliation: paper.affiliation,
      current_version: paper.current_version,
      current: {
        title: current.title,
        abstract: current.abstract,
        tags: current.tags,
        external_link: current.external_link,
        submitted_at: current.submitted_at,
        approved_at: current.approved_at,
      },
      versions: paper.versions.map((v) => ({
        version: v.version,
        title: v.title,
        abstract: v.abstract,
        tags: v.tags,
        external_link: v.external_link,
        submitted_at: v.submitted_at,
        approved_at: v.approved_at,
        change_note: v.change_note,
      })),
      thread_connections: paper.thread_connections || [],
      gravity_score: paper.gravity_score || 0,
    });
  }

  // Search: ?search=query
  if (params.search) {
    const index = await getJSON(store, "repo_index");
    if (!index || !index.papers) return ok({ query: params.search, results: [] });

    const q = params.search.toLowerCase();
    const results = index.papers
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.abstract_snippet || "").toLowerCase().includes(q) ||
          (p.tags || []).some((t) => t.toLowerCase().includes(q))
      )
      .map((p) => ({
        paper_id: p.paper_id,
        title: p.title,
        author_name: p.author_name,
        abstract_snippet: p.abstract_snippet,
        tags: p.tags,
      }));

    return ok({ query: params.search, results });
  }

  // Author papers: ?author=atok_abc (requires token match)
  if (params.author) {
    const author = await getJSON(store, `author:${params.author}`);
    if (!author) return err(404, "Author not found.");

    const paperSummaries = [];
    for (const pid of author.paper_ids || []) {
      const paper = await getJSON(store, `paper:${pid}`);
      if (!paper) continue;
      const cur = paper.versions[paper.current_version - 1] || {};
      paperSummaries.push({
        paper_id: paper.paper_id,
        title: cur.title,
        status: paper.status,
        current_version: paper.current_version,
      });
    }

    // Also check pending submissions for this author
    const pending = await getJSON(store, "repo_pending");
    if (pending && pending.submissions) {
      for (const sub of pending.submissions) {
        if (sub.author_token === params.author && sub.status === "pending") {
          paperSummaries.push({
            paper_id: null,
            submission_id: sub.submission_id,
            title: sub.title,
            status: "pending",
            current_version: 0,
          });
        }
      }
    }

    return ok({
      author_name: author.author_name,
      affiliation: author.affiliation,
      papers: paperSummaries,
      chat_identity_linked: author.chat_identity_linked || false,
    });
  }

  // Default: landing data (repo_index)
  const index = await getJSON(store, "repo_index");
  if (!index) {
    return ok({
      papers: [],
      total_papers: 0,
      total_authors: 0,
      all_tags: [],
    });
  }

  // Sort by gravity_score descending
  const sorted = [...(index.papers || [])].sort(
    (a, b) => (b.gravity_score || 0) - (a.gravity_score || 0)
  );

  return ok({
    papers: sorted,
    total_papers: index.total_papers || sorted.length,
    total_authors: index.total_authors || 0,
    all_tags: index.all_tags || [],
  });
}

// ── POST Handler ────────────────────────────────────────────

async function handlePost(event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return err(400, "Invalid JSON body.");
  }

  const store = connectStore(event);
  const action = body.action;

  // ── Submit ──────────────────────────────────────────────

  if (action === "submit") {
    return handleSubmit(store, body);
  }

  // ── Review (Admin) ─────────────────────────────────────

  if (action === "review") {
    return handleReview(store, body);
  }

  // ── Edit (Author) ──────────────────────────────────────

  if (action === "edit") {
    return handleEdit(store, body);
  }

  // ── Request Magic Link ─────────────────────────────────

  if (action === "request_magic_link") {
    return handleMagicLink(store, body);
  }

  // ── Link Chat Identity ─────────────────────────────────

  if (action === "link_chat_identity") {
    return handleLinkChat(store, body);
  }

  // ── Get Pending (Admin) ────────────────────────────────

  if (action === "get_pending") {
    const { secret } = body;
    if (!MIKE_SECRET || secret !== MIKE_SECRET) {
      return err(403, "Unauthorized.");
    }
    const pending = (await getJSON(store, "repo_pending")) || { submissions: [] };
    return ok({ ok: true, submissions: pending.submissions || [] });
  }

  return err(400, `Unknown action: ${action}`);
}

// ── Submit ──────────────────────────────────────────────────

async function handleSubmit(store, body) {
  const { title, author_name, affiliation, abstract, tags, external_link, pdf_data, contact_email } = body;

  // 1. Coherence check
  const coherence = coherenceCheck({ title, abstract, tags, external_link, pdf_data });
  if (!coherence.passed) {
    return err(400, "Validation failed.", {
      status: "validation_error",
      errors: coherence.errors,
    });
  }

  // 2. Duplicate detection
  const index = await getJSON(store, "repo_index");
  const existingPapers = index ? index.papers : [];
  const dupResult = await duplicateDetection(title, abstract, existingPapers);

  if (dupResult.duplicates_found) {
    return ok({
      ok: false,
      status: "duplicate_detected",
      message: "This aligns closely with existing work in the repository.",
      matches: dupResult.matches.map((m) => ({
        paper_id: m.paper_id,
        title: m.title,
        reason: m.reason,
      })),
    });
  }

  // 3. Generate author token (or find existing by email)
  let authorToken = null;

  if (contact_email) {
    authorToken = await findAuthorByEmail(store, contact_email);
  }

  if (!authorToken) {
    authorToken = generateToken();
    // Create author record
    await putJSON(store, `author:${authorToken}`, {
      author_token: authorToken,
      author_name: author_name || "Anonymous",
      affiliation: affiliation || "",
      contact_email: contact_email || "",
      created_at: now(),
      paper_ids: [],
      chat_user_id: null,
      chat_identity_linked: false,
    });

    // Index email for O(1) lookup
    if (contact_email) {
      await updateEmailIndex(store, contact_email, authorToken);
    }
  }

  // 4. Create submission
  const submissionId = generateId("sub");
  const submission = {
    submission_id: submissionId,
    title: title.trim(),
    author_name: (author_name || "Anonymous").trim(),
    author_token: authorToken,
    affiliation: (affiliation || "").trim(),
    abstract: abstract.trim(),
    tags: [...new Set((tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
    pdf_data: pdf_data || null,
    external_link: (external_link || "").trim() || null,
    contact_email: (contact_email || "").trim() || null,
    submitted_at: now(),
    auto_check_results: {
      coherence: { passed: true },
      duplicate_detection: dupResult,
    },
    status: "pending",
  };

  // Add to pending queue
  const pending = (await getJSON(store, "repo_pending")) || { submissions: [] };
  pending.submissions.push(submission);
  await putJSON(store, "repo_pending", pending);

  // Send magic link email if we have an email
  if (contact_email) {
    await sendMagicLinkEmail(contact_email, authorToken);
  }

  return ok({
    ok: true,
    submission_id: submissionId,
    status: "pending",
    message: "Submitted. Under review.",
  });
}

// ── Review (Admin) ──────────────────────────────────────────

async function handleReview(store, body) {
  const { submission_id, decision, reason, secret } = body;

  // Auth check
  if (!MIKE_SECRET || secret !== MIKE_SECRET) {
    return err(403, "Unauthorized.");
  }
  if (!submission_id || !decision) {
    return err(400, "submission_id and decision required.");
  }
  if (!["approve", "reject"].includes(decision)) {
    return err(400, 'Decision must be "approve" or "reject".');
  }

  const pending = (await getJSON(store, "repo_pending")) || { submissions: [] };
  const subIdx = pending.submissions.findIndex(
    (s) => s.submission_id === submission_id
  );
  if (subIdx === -1) {
    return err(404, "Submission not found in pending queue.");
  }

  const sub = pending.submissions[subIdx];

  if (decision === "reject") {
    sub.status = "rejected";
    sub.rejected_at = now();
    sub.rejection_reason = reason || "No reason given.";
    pending.submissions[subIdx] = sub;
    await putJSON(store, "repo_pending", pending);

    return ok({
      ok: true,
      status: "rejected",
      submission_id,
      message: reason || "Rejected.",
    });
  }

  // ── Approve ──

  // Remove from pending
  pending.submissions.splice(subIdx, 1);
  await putJSON(store, "repo_pending", pending);

  const timestamp = now();

  // ── Revision of existing paper ──
  if (sub.is_revision && sub.paper_id) {
    const paper = await getJSON(store, `paper:${sub.paper_id}`);
    if (!paper) return err(404, "Original paper not found for revision.");

    const newVersionNum = paper.current_version + 1;

    const versionEntry = {
      version: newVersionNum,
      title: sub.title,
      abstract: sub.abstract,
      tags: sub.tags,
      pdf_key: sub.pdf_data ? `pdf:${sub.paper_id}_v${newVersionNum}` : (paper.versions[paper.current_version - 1] || {}).pdf_key || null,
      external_link: sub.external_link,
      submitted_at: sub.submitted_at,
      approved_at: timestamp,
      change_note: sub.change_note || null,
    };

    paper.versions.push(versionEntry);
    paper.current_version = newVersionNum;
    await putJSON(store, `paper:${sub.paper_id}`, paper);

    // Store PDF blob if present
    if (sub.pdf_data) {
      await store.set(`pdf:${sub.paper_id}_v${newVersionNum}`, sub.pdf_data);
    }

    // Update repo_index with new version metadata
    await updateIndexForPaper(store, sub.paper_id, {
      title: sub.title,
      tags: sub.tags,
      abstract_snippet: snippetize(sub.abstract),
      current_version: newVersionNum,
      external_link: sub.external_link,
    });

    return ok({
      ok: true,
      status: "approved",
      paper_id: sub.paper_id,
      version: newVersionNum,
      message: "Revision approved and published.",
    });
  }

  // ── New submission ──

  const paperId = generateId("paper");

  const paper = {
    paper_id: paperId,
    author_name: sub.author_name,
    author_token: sub.author_token,
    affiliation: sub.affiliation,
    contact_email: sub.contact_email,
    current_version: 1,
    versions: [
      {
        version: 1,
        title: sub.title,
        abstract: sub.abstract,
        tags: sub.tags,
        pdf_key: sub.pdf_data ? `pdf:${paperId}_v1` : null,
        external_link: sub.external_link,
        submitted_at: sub.submitted_at,
        approved_at: timestamp,
        change_note: null,
      },
    ],
    thread_connections: [],
    gravity_score: 0,
    status: "approved",
  };

  await putJSON(store, `paper:${paperId}`, paper);

  // Store PDF blob if present
  if (sub.pdf_data) {
    await store.set(`pdf:${paperId}_v1`, sub.pdf_data);
  }

  // Update author record
  const author = await getJSON(store, `author:${sub.author_token}`);
  if (author) {
    author.paper_ids = author.paper_ids || [];
    author.paper_ids.push(paperId);
    author.author_name = sub.author_name;
    author.affiliation = sub.affiliation;
    await putJSON(store, `author:${sub.author_token}`, author);
  }

  // Update email-to-token index
  if (sub.contact_email) {
    await updateEmailIndex(store, sub.contact_email, sub.author_token);
  }

  // Update repo_index
  const index = (await getJSON(store, "repo_index")) || {
    papers: [],
    total_papers: 0,
    total_authors: 0,
    all_tags: [],
  };

  index.papers.push({
    paper_id: paperId,
    title: sub.title,
    author_name: sub.author_name,
    submitted_at: sub.submitted_at,
    approved_at: timestamp,
    current_version: 1,
    tags: sub.tags,
    abstract_snippet: snippetize(sub.abstract),
    gravity_score: 0,
    thread_connections: 0,
    external_link: sub.external_link,
  });

  // Recount totals
  index.total_papers = index.papers.length;
  const uniqueAuthors = new Set(index.papers.map((p) => p.author_name));
  index.total_authors = uniqueAuthors.size;
  const allTagSet = new Set();
  for (const p of index.papers) {
    for (const t of p.tags || []) allTagSet.add(t);
  }
  index.all_tags = [...allTagSet].sort();

  await putJSON(store, "repo_index", index);

  return ok({
    ok: true,
    status: "approved",
    paper_id: paperId,
    message: "Paper approved and published.",
  });
}

// ── Edit (Author) ───────────────────────────────────────────

async function handleEdit(store, body) {
  const { paper_id, author_token, title, abstract, tags, external_link, pdf_data, change_note } = body;

  if (!paper_id || !author_token) {
    return err(400, "paper_id and author_token required.");
  }
  if (!change_note || change_note.trim().length === 0) {
    return err(400, "Change note is required — describe what changed.");
  }

  const paper = await getJSON(store, `paper:${paper_id}`);
  if (!paper) return err(404, "Paper not found.");
  if (paper.author_token !== author_token) return err(403, "Unauthorized.");
  if (paper.status !== "approved") {
    return err(400, "Only approved papers can be edited.");
  }

  const currentVersion = paper.versions[paper.current_version - 1];

  // Build new version data, falling back to current for unchanged fields
  const newData = {
    title: (title || currentVersion.title).trim(),
    abstract: (abstract || currentVersion.abstract).trim(),
    tags: [...new Set((tags && tags.length > 0 ? tags : currentVersion.tags).map((t) => t.trim().toLowerCase()).filter(Boolean))],
    external_link: external_link !== undefined ? (external_link || "").trim() || null : currentVersion.external_link,
    pdf_data: pdf_data || null,
  };

  // Coherence check on the new version
  const coherence = coherenceCheck({
    title: newData.title,
    abstract: newData.abstract,
    tags: newData.tags,
    external_link: newData.external_link || currentVersion.external_link,
    pdf_data: newData.pdf_data || currentVersion.pdf_key,
  });
  if (!coherence.passed) {
    return err(400, "Validation failed.", {
      status: "validation_error",
      errors: coherence.errors,
    });
  }

  // Classify minor or major
  const editType = classifyEdit(currentVersion, {
    title: newData.title,
    abstract: newData.abstract,
    pdf_data: newData.pdf_data,
  });

  const newVersionNum = paper.current_version + 1;
  const timestamp = now();

  const versionEntry = {
    version: newVersionNum,
    title: newData.title,
    abstract: newData.abstract,
    tags: newData.tags,
    pdf_key: newData.pdf_data ? `pdf:${paper_id}_v${newVersionNum}` : currentVersion.pdf_key,
    external_link: newData.external_link,
    submitted_at: timestamp,
    approved_at: editType === "minor" ? timestamp : null,
    change_note: change_note.trim(),
  };

  if (editType === "minor") {
    // Live immediately
    paper.versions.push(versionEntry);
    paper.current_version = newVersionNum;
    await putJSON(store, `paper:${paper_id}`, paper);

    // Store PDF if present
    if (newData.pdf_data) {
      await store.set(`pdf:${paper_id}_v${newVersionNum}`, newData.pdf_data);
    }

    // Update repo_index
    await updateIndexForPaper(store, paper_id, {
      title: newData.title,
      tags: newData.tags,
      abstract_snippet: snippetize(newData.abstract),
      current_version: newVersionNum,
      external_link: newData.external_link,
    });

    return ok({
      ok: true,
      status: "updated",
      version: newVersionNum,
      edit_type: "minor",
    });
  }

  // Major revision → enters pending queue
  const pending = (await getJSON(store, "repo_pending")) || { submissions: [] };
  pending.submissions.push({
    submission_id: generateId("rev"),
    paper_id,
    title: newData.title,
    author_name: paper.author_name,
    author_token,
    affiliation: paper.affiliation,
    abstract: newData.abstract,
    tags: newData.tags,
    pdf_data: newData.pdf_data,
    external_link: newData.external_link,
    contact_email: paper.contact_email,
    submitted_at: timestamp,
    change_note: change_note.trim(),
    is_revision: true,
    previous_version: paper.current_version,
    auto_check_results: {
      coherence: { passed: true },
      duplicate_detection: { checked: false, duplicates_found: false, matches: [] },
    },
    status: "pending",
  });
  await putJSON(store, "repo_pending", pending);

  return ok({
    ok: true,
    status: "revision_pending",
    version: newVersionNum,
    edit_type: "major",
    message: "Revision submitted for review.",
  });
}

// ── Magic Link Request ──────────────────────────────────────

async function handleMagicLink(store, body) {
  const { email } = body;
  if (!email || !email.includes("@")) {
    return err(400, "Valid email required.");
  }

  const token = await findAuthorByEmail(store, email.trim());
  if (!token) {
    return ok({
      ok: true,
      message: "If an account exists for this email, a magic link has been sent.",
    });
  }

  await sendMagicLinkEmail(email.trim(), token);

  return ok({
    ok: true,
    message: "If an account exists for this email, a magic link has been sent.",
  });
}

// ── Link Chat Identity ──────────────────────────────────────

async function handleLinkChat(store, body) {
  const { author_token, chat_user_id } = body;
  if (!author_token || !chat_user_id) {
    return err(400, "author_token and chat_user_id required.");
  }

  const author = await getJSON(store, `author:${author_token}`);
  if (!author) return err(404, "Author not found.");

  author.chat_user_id = chat_user_id;
  author.chat_identity_linked = true;
  await putJSON(store, `author:${author_token}`, author);

  return ok({
    ok: true,
    message: "Chat identity linked.",
    chat_identity_linked: true,
  });
}

// ── Index Update Helper ─────────────────────────────────────

async function updateIndexForPaper(store, paperId, updates) {
  const index = (await getJSON(store, "repo_index")) || {
    papers: [],
    total_papers: 0,
    total_authors: 0,
    all_tags: [],
  };

  const idx = index.papers.findIndex((p) => p.paper_id === paperId);
  if (idx === -1) return;

  Object.assign(index.papers[idx], updates);

  // Rebuild all_tags
  const allTagSet = new Set();
  for (const p of index.papers) {
    for (const t of p.tags || []) allTagSet.add(t);
  }
  index.all_tags = [...allTagSet].sort();

  await putJSON(store, "repo_index", index);
}

// ── Email-to-Token Index ─────────────────────────────────────
// Key: "email_index" → { "email@example.com": "atok_abc...", ... }
// Updated on submission and approval. O(1) lookup instead of scanning all papers.

async function updateEmailIndex(store, email, authorToken) {
  const emailLower = email.toLowerCase().trim();
  if (!emailLower) return;

  const emailIndex = (await getJSON(store, "email_index")) || {};
  emailIndex[emailLower] = authorToken;
  await putJSON(store, "email_index", emailIndex);
}

async function findAuthorByEmail(store, email) {
  const emailLower = email.toLowerCase().trim();
  if (!emailLower) return null;

  const emailIndex = (await getJSON(store, "email_index")) || {};
  const token = emailIndex[emailLower];
  if (!token) return null;

  // Verify the author record still exists
  const author = await getJSON(store, `author:${token}`);
  return author ? token : null;
}

// ── Main Handler ────────────────────────────────────────────

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    if (event.httpMethod === "GET") {
      return await handleGet(event);
    }
    if (event.httpMethod === "POST") {
      return await handlePost(event);
    }
    return err(405, "Method not allowed.");
  } catch (e) {
    console.error("repository.js error:", e);
    return err(500, "Internal server error.");
  }
};
