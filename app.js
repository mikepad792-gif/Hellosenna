
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("sendBtn");
    const thinkingEl = document.getElementById("thinking");
    const archivePanel = document.getElementById("archivePanel");
    const archiveToggle = document.getElementById("archiveToggle");
    const mobileOverlay = document.getElementById("mobileOverlay");
    const archiveList = document.getElementById("archiveList");
    const archiveSubtabs = document.getElementById("archiveSubtabs");
    const statusBar = document.getElementById("statusBar");
    const reflectBtn = document.getElementById("reflectBtn");
    const resetBtn = document.getElementById("resetBtn");
    const titleEl = document.getElementById("titleEl");
    const fileBtn = document.getElementById("fileBtn");
    const fileInput = document.getElementById("fileInput");
    const fileList = document.getElementById("fileList");

    let messages = [];
    let loading = false;
    let attachedFiles = [];
    let mikeSecret = localStorage.getItem("mike_secret") || "";
    let archiveState = { archives: {}, working_memory: {} };
    let archiveMode = "archives";
    let selectedArchive = "public";
    let selectedBucket = "active_questions";
    let pressTimer = null;
    let displayName = "You";

    const archiveNames = [
      "public",
      "philosophy",
      "science",
      "nature",
      "supernatural",
      "questions",
      "senna_threads",
      "reflections",
      "retired"
    ];

    const bucketNames = [
      "active_questions",
      "active_threads",
      "active_tensions"
    ];

    function prettyName(name) {
      return String(name || "").replace(/_/g, " ");
    }

    function splitParagraphs(text) {
      return String(text || "")
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function formatDate(value) {
      if (!value) return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    }

    function updateStatus(text = "") {
      statusBar.textContent = text;
    }

    function scrollMessages() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function autoResize() {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
    }

    function updateAdminUI() {
  const visible = !!mikeSecret;
  reflectBtn.style.display = visible ? "inline-block" : "none";
  resetBtn.style.display = visible ? "inline-block" : "none";
}

    function renderMessages() {
      if (!messages.length) {
        messagesEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-box">
              <div class="empty-mark">◊</div>
              <div class="empty-title">The atelier is quiet.</div>
              <div class="empty-note">
                Senna is here. The archive waits. Thought can begin wherever you are.
              </div>
            </div>
          </div>
        `;
        return;
      }

      messagesEl.innerHTML = messages.map((msg) => {
        const who = msg.role === "assistant" ? "Senna" : displayName;
        const mark = msg.role === "assistant" ? "◊" : "Y";

        const textContent = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter(part => part.type === "text")
                .map(part => part.text)
                .join("\n\n")
            : "";

        const paras = splitParagraphs(textContent)
          .map(p => `<p>${escapeHtml(p)}</p>`)
          .join("");

        const attachmentMeta = Array.isArray(msg.content)
          ? msg.content
              .filter(part => part.type === "image" || part.type === "document")
              .map(() => `<div class="msg-meta">attachment included</div>`)
              .join("")
          : "";

        const archivePills = Array.isArray(msg.archives_used) && msg.archives_used.length
          ? `
            <div class="archives-used">
              ${msg.archives_used.map(a => `<span class="pill">${escapeHtml(prettyName(a))}</span>`).join("")}
            </div>
          `
          : "";

        return `
          <article class="msg ${msg.role}">
            <div class="msg-mark ${msg.role === "assistant" ? "assistant" : ""}">${mark}</div>
            <div class="msg-body">
              <div class="msg-who">${escapeHtml(who)}</div>
              <div class="msg-text">${paras}</div>
              ${attachmentMeta}
              ${archivePills}
            </div>
          </article>
        `;
      }).join("");

      scrollMessages();
    }


    function openArchive() {
      archivePanel.classList.remove("hidden");
      if (window.innerWidth <= 920) mobileOverlay.style.display = "block";
    }

    function closeArchive() {
      archivePanel.classList.add("hidden");
      mobileOverlay.style.display = "none";
    }

    function toggleArchive() {
      if (archivePanel.classList.contains("hidden")) openArchive();
      else closeArchive();
      archiveToggle.setAttribute("aria-expanded", String(!archivePanel.classList.contains("hidden")));
    }

    function openFilePicker() {
      if (typeof fileInput.showPicker === "function") {
        fileInput.showPicker();
        return;
      }
      fileInput.click();
    }

    function renderArchiveSubtabs() {
  const source = archiveMode === "archives" ? archiveNames : bucketNames;
  const selected = archiveMode === "archives" ? selectedArchive : selectedBucket;

  archiveSubtabs.innerHTML = source.map(name => `
    <button
      type="button"
      class="tab-btn ${selected === name ? "active" : ""}"
      data-subtab="${name}"
    >
      ${escapeHtml(prettyName(name))}
    </button>
  `).join("");
}

    function renderArchiveList() {
  if (archiveMode === "archives") {
    const entries = archiveState?.archives?.[selectedArchive] || [];

    if (!entries.length) {
      archiveList.innerHTML = `<div class="archive-empty">Nothing has been kept here yet.</div>`;
      return;
    }

    archiveList.innerHTML = entries.map(entry => `
      <div class="archive-entry">
        <div class="archive-entry-meta">
          <span class="pill">${escapeHtml(entry.type || "idea")}</span>
          <span class="pill">${escapeHtml(entry.origin || "senna")}</span>
          ${Array.isArray(entry.tags) && entry.tags.length
            ? entry.tags.slice(0, 3).map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join("")
            : ""}
        </div>
        <div class="archive-entry-text">${escapeHtml(entry.title ? entry.title + "\n\n" + (entry.text || "") : (entry.text || ""))}</div>
        <div class="archive-entry-date">${escapeHtml(formatDate(entry.last_updated || entry.date))}</div>
      </div>
    `).join("");
    return;
  }

  const items = archiveState?.working_memory?.[selectedBucket] || [];

  if (!items.length) {
    archiveList.innerHTML = `<div class="archive-empty">Nothing is active here yet.</div>`;
    return;
  }

  archiveList.innerHTML = items.map(item => `
    <div class="archive-entry">
      <div class="archive-entry-meta">
        <span class="pill">${escapeHtml(item.origin || "senna")}</span>
        <span class="pill">${escapeHtml(item.status || "active")}</span>
        ${Array.isArray(item.tags) && item.tags.length
          ? item.tags.slice(0, 3).map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join("")
          : ""}
      </div>
      <div class="archive-entry-text">${escapeHtml(item.text || "")}</div>
      <div class="archive-entry-date">${escapeHtml(formatDate(item.date))}</div>
    </div>
  `).join("");
}

async function loadArchiveState() {
  try {
    const res = await fetch("/.netlify/functions/archive");
    const data = await res.json();

    archiveState = data || { archives: {}, working_memory: {} };
    if (!archiveState.archives) archiveState.archives = {};
    if (!archiveState.working_memory) archiveState.working_memory = {};

    const savedName = archiveState?.working_memory?.user_profile?.display_name;
    if (savedName) displayName = savedName;

    renderArchiveSubtabs();
    renderArchiveList();
    bindArchiveModeButtons();
  } catch (err) {
    archiveList.innerHTML = `<div class="archive-empty">The archive is quiet, but the path to it is broken.</div>`;
  }
}

function renderFileList() {
      if (!attachedFiles.length) {
        fileList.textContent = "";
        return;
      }

      fileList.innerHTML = attachedFiles
        .map(f => `<span class="file-pill">${escapeHtml(f.name)}</span>`)
        .join("");
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          const result = reader.result || "";
          const base64 = String(result).split(",")[1];
          resolve({
            name: file.name,
            mediaType: file.type || "application/octet-stream",
            base64
          });
        };

        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }
async function sendMessage() {
      const text = inputEl.value.trim();
      if ((!text && attachedFiles.length === 0) || loading) return;

      loading = true;
      sendBtn.disabled = true;
      thinkingEl.style.display = "flex";

      let userContent;

      if (attachedFiles.length > 0) {
        const parts = [];

        for (const file of attachedFiles) {
          if (file.mediaType === "application/pdf") {
            parts.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: file.base64
              }
            });
          } else if (file.mediaType.startsWith("image/")) {
            parts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: file.mediaType,
                data: file.base64
              }
            });
          } else {
            parts.push({
              type: "text",
              text: `[Attached file: ${file.name}]`
            });
          }
        }

        if (text) {
          parts.push({
            type: "text",
            text
          });
        }

        userContent = parts;
      } else {
        userContent = text;
      }

      const userMsg = { role: "user", content: userContent };
      messages.push(userMsg);
      renderMessages();

      inputEl.value = "";
      inputEl.style.height = "56px";
      attachedFiles = [];
      renderFileList();
      updateStatus("");

      try {
        const payload = {
          messages: messages.map(m => ({
            role: m.role,
            content: m.content
          }))
        };

        const res = await fetch("/.netlify/functions/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data?.error || "The response failed to arrive.");
        }

        if (data.display_name) {
          displayName = data.display_name;
        }

        messages.push({
          role: "assistant",
          content: data.content || "The response failed to arrive.",
          archives_used: data.archives_used || []
        });

        renderMessages();
        await loadArchiveState();

      } catch (err) {

        messages.push({
          role: "assistant",
          content: "The response failed to arrive. Try again."
        });

        renderMessages();
        updateStatus(err.message || "Transmission error.");

      } finally {

        loading = false;
        sendBtn.disabled = false;
        thinkingEl.style.display = "none";

      }
    }

    window.sendMessage = sendMessage;

    async function triggerReflection() {

      if (!mikeSecret || loading) return;

      reflectBtn.disabled = true;
      updateStatus("Running reflection...");

      try {

        const res = await fetch("/.netlify/functions/reflect", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            secret: mikeSecret
          })
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data?.error || "Reflection failed.");
        }

        await loadArchiveState();
        updateStatus(`Reflection saved: ${data.title || "untitled"}`);

      } catch (err) {

        updateStatus(err.message || "Reflection failed.");

      } finally {

        reflectBtn.disabled = false;

      }
    }

    async function resetSennaMemory() {

      if (!mikeSecret || loading) return;

      const confirmed = confirm("Clear all Senna memory?");
      if (!confirmed) return;

      resetBtn.disabled = true;

      try {

        const res = await fetch("/.netlify/functions/archive", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: "reset_all",
            secret: mikeSecret
          })
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data?.error || "Reset failed.");
        }

        messages = [];
        displayName = "You";

        await loadArchiveState();
        renderMessages();

        updateStatus("Senna memory cleared.");

      } catch (err) {

        updateStatus(err.message || "Reset failed.");

      } finally {

        resetBtn.disabled = false;

      }
    }

    function handleAdminUnlock() {

      const entered = prompt("Enter admin secret");

      if (entered && entered.trim()) {
        mikeSecret = entered.trim();
        localStorage.setItem("mike_secret", mikeSecret);
        updateAdminUI();
        updateStatus("Admin unlocked.");
      }
    }

    archiveToggle.setAttribute("type", "button");
    archiveToggle.setAttribute("aria-expanded", "false");
    archiveToggle.addEventListener("click", toggleArchive);
    fileBtn.addEventListener("click", openFilePicker);
    mobileOverlay.addEventListener("click", closeArchive);
    reflectBtn.addEventListener("click", triggerReflection);
    resetBtn.addEventListener("click", resetSennaMemory);


function bindArchiveModeButtons() {
  document.querySelectorAll("[data-mode]").forEach(btn => {
    btn.onclick = () => {
      archiveMode = btn.dataset.mode;

      document.querySelectorAll("[data-mode]").forEach(b => {
        b.classList.toggle("active", b.dataset.mode === archiveMode);
      });

      renderArchiveSubtabs();
      renderArchiveList();
    };
  });
}

archiveSubtabs.onclick = (e) => {
  const subtabBtn = e.target.closest("[data-subtab]");
  if (!subtabBtn) return;

  if (archiveMode === "archives") {
    selectedArchive = subtabBtn.dataset.subtab;
  } else {
    selectedBucket = subtabBtn.dataset.subtab;
  }

  renderArchiveSubtabs();
  renderArchiveList();
};

fileInput.addEventListener("change", async (e) => {


      const files = Array.from(e.target.files || []);
      if (!files.length) return;

      const converted = [];

      for (const file of files) {
        try {
          const processed = await fileToBase64(file);
          converted.push(processed);
        } catch (err) {
          console.error("File conversion failed:", file.name);
        }
      }

      attachedFiles = [...attachedFiles, ...converted];
      renderFileList();
      updateStatus(converted.length ? `${converted.length} file${converted.length === 1 ? "" : "s"} attached.` : "No files were attached.");
      fileInput.value = "";

    });

    inputEl.addEventListener("input", autoResize);

    inputEl.addEventListener("keydown", (e) => {

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }

    });

    titleEl.addEventListener("mousedown", () => {
      pressTimer = setTimeout(handleAdminUnlock, 800);
    });

    titleEl.addEventListener("mouseup", () => {
      clearTimeout(pressTimer);
    });

    titleEl.addEventListener("mouseleave", () => {
      clearTimeout(pressTimer);
    });

    window.addEventListener("resize", () => {

      if (window.innerWidth > 920) {
        mobileOverlay.style.display = "none";
      } else if (!archivePanel.classList.contains("hidden")) {
        mobileOverlay.style.display = "block";
      }

    });

    loadArchiveState();
    renderMessages();
    updateAdminUI();

  