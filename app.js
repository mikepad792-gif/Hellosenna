/* ==============================================
   SENNA — app.js
   Chat + Sidebar + File Attachments + Admin
   ============================================== */
(function () {
  "use strict";

  /* ── Config ──────────────────────────────── */
  var API_BASE    = "/.netlify/functions";
  var CHAT_URL    = API_BASE + "/chat";
  var ARCHIVE_URL = API_BASE + "/archive";
  var REFLECT_URL = API_BASE + "/reflect";

  /* ── DOM refs ────────────────────────────── */
  var $messages            = document.getElementById("messages");
  var $emptyState          = document.getElementById("emptyState");
  var $thinking            = document.getElementById("thinking");
  var $input               = document.getElementById("userInput");
  var $sendBtn             = document.getElementById("sendBtn");
  var $statusBar           = document.getElementById("statusBar");
  var $consentNotice       = document.getElementById("consentNotice");
  var $consentDismiss      = document.getElementById("consentDismiss");
  var $sidebarToggle       = document.getElementById("sidebarToggle");
  var $sidebar             = document.getElementById("sidebar");
  var $sidebarBackdrop     = document.getElementById("sidebarBackdrop");
  var $sidebarThreadsList  = document.getElementById("sidebarThreadsList");
  var $sidebarTensionsList = document.getElementById("sidebarTensionsList");
  var $sidebarThinkingList = document.getElementById("sidebarThinkingList");
  var $fileBtn             = document.getElementById("fileBtn");
  var $filePills           = document.getElementById("filePills");
  var $title               = document.querySelector(".title");

  /* ── Create hidden file input ──────────── */
  var $fileInput = document.createElement("input");
  $fileInput.type = "file";
  $fileInput.multiple = true;
  $fileInput.accept = "image/*,.pdf,.txt,.md,.csv,.json";
  $fileInput.style.display = "none";
  document.body.appendChild($fileInput);

  /* ── State ───────────────────────────────── */
  var conversationHistory = [];
  var displayName = "You";
  var sending = false;
  var attachedFiles = [];  // { name, mediaType, base64 }
  var userId;
  var mikeSecret = "";
  var adminPressTimer = null;

  /* ========================================
     USER ID
     ======================================== */
  function loadOrCreateUserId() {
    var id = localStorage.getItem("senna_user_id");
    if (!id) {
      id = "user_" + crypto.randomUUID().slice(0, 12);
      localStorage.setItem("senna_user_id", id);
    }
    return id;
  }

  /* ========================================
     CONSENT NOTICE
     ======================================== */
  function initConsent() {
    if (localStorage.getItem("senna_consent_seen") === "1") {
      $consentNotice.classList.remove("visible");
    }
    $consentDismiss.addEventListener("click", function () {
      localStorage.setItem("senna_consent_seen", "1");
      $consentNotice.classList.remove("visible");
    });
  }

  /* ========================================
     SIDEBAR TOGGLE (mobile)
     ======================================== */
  function initSidebarToggle() {
    $sidebarToggle.addEventListener("click", function () {
      var isOpen = $sidebar.classList.toggle("open");
      $sidebarBackdrop.classList.toggle("visible", isOpen);
      $sidebarToggle.textContent = isOpen ? "close" : "archive";
    });

    $sidebarBackdrop.addEventListener("click", function () {
      $sidebar.classList.remove("open");
      $sidebarBackdrop.classList.remove("visible");
      $sidebarToggle.textContent = "archive";
    });
  }

  /* ========================================
     SIDEBAR DATA
     ======================================== */
  async function loadSidebar() {
    try {
      var res = await fetch(
        ARCHIVE_URL + "?view=sidebar&user_id=" + encodeURIComponent(userId)
      );
      if (!res.ok) return;
      var data = await res.json();
      renderSidebar(data);
    } catch (e) {
      /* Sidebar fails silently — chat still works */
    }
  }

  function renderSidebar(data) {
    /* Your threads */
    if (data.visitor_threads && data.visitor_threads.length > 0) {
      $sidebarThreadsList.innerHTML = data.visitor_threads
        .slice(0, 5)
        .map(function (t) {
          return '<div class="sidebar-item">'
            + '<div class="sidebar-item-text">'
            + '<a href="/archive.html#thread=' + encodeURIComponent(t.thread_id) + '">'
            + escapeHtml(t.title)
            + '</a></div>'
            + (t.last_active
              ? '<div class="sidebar-item-date">' + timeAgo(t.last_active) + '</div>'
              : '')
            + '</div>';
        }).join("");
    } else {
      $sidebarThreadsList.innerHTML =
        '<div class="sidebar-empty">No threads yet — they emerge through conversation.</div>';
    }

    /* Active tensions + questions */
    var tensions = [];
    if (data.active_tensions) tensions = tensions.concat(data.active_tensions);
    if (data.active_questions) tensions = tensions.concat(data.active_questions);
    tensions = tensions.slice(0, 5);

    if (tensions.length > 0) {
      $sidebarTensionsList.innerHTML = tensions
        .map(function (t) {
          return '<div class="sidebar-item">'
            + '<div class="sidebar-item-text">' + escapeHtml(t.text) + '</div>'
            + '</div>';
        }).join("");
    } else {
      $sidebarTensionsList.innerHTML =
        '<div class="sidebar-empty">Nothing unresolved at the moment.</div>';
    }

    /* Senna's recent thinking */
    var thinking = [];
    if (data.recent_reflections) {
      thinking = thinking.concat(data.recent_reflections.map(function (r) {
        return { text: r.text, date: r.date, type: "reflection", id: r.id };
      }));
    }
    if (data.recent_threads) {
      thinking = thinking.concat(data.recent_threads.map(function (t) {
        return { text: t.snippet || t.title, date: t.last_updated, type: "thread", id: t.thread_id };
      }));
    }
    thinking.sort(function (a, b) {
      return (b.date || "").localeCompare(a.date || "");
    });
    thinking = thinking.slice(0, 3);

    if (thinking.length > 0) {
      $sidebarThinkingList.innerHTML = thinking
        .map(function (t) {
          var linkTarget = t.type === "thread"
            ? '/archive.html#thread=' + encodeURIComponent(t.id)
            : '/archive.html#reflection=' + encodeURIComponent(t.id);
          return '<div class="sidebar-item">'
            + '<div class="sidebar-item-text">'
            + '<a href="' + linkTarget + '">'
            + escapeHtml(truncate(t.text, 100))
            + '</a></div>'
            + (t.date
              ? '<div class="sidebar-item-date">' + timeAgo(t.date) + '</div>'
              : '')
            + '</div>';
        }).join("");
    } else {
      $sidebarThinkingList.innerHTML =
        '<div class="sidebar-empty">Senna hasn\'t reflected yet.</div>';
    }
  }

  /* ========================================
     FILE ATTACHMENTS
     ======================================== */
  function initFileAttachments() {
    if (!$fileBtn) return;

    $fileBtn.addEventListener("click", function () {
      $fileInput.click();
    });

    $fileInput.addEventListener("change", async function (e) {
      var files = Array.from(e.target.files || []);
      if (!files.length) return;

      for (var i = 0; i < files.length; i++) {
        try {
          var processed = await fileToBase64(files[i]);
          attachedFiles.push(processed);
        } catch (err) {
          console.error("File conversion failed:", files[i].name);
        }
      }

      renderFilePills();
      $fileInput.value = "";
    });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = reader.result || "";
        var base64 = String(result).split(",")[1];
        resolve({
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          base64: base64
        });
      };
      reader.onerror = function () {
        reject(new Error("Failed to read file"));
      };
      reader.readAsDataURL(file);
    });
  }

  function renderFilePills() {
    if (!$filePills) return;
    if (!attachedFiles.length) {
      $filePills.innerHTML = "";
      return;
    }
    $filePills.innerHTML = attachedFiles
      .map(function (f, i) {
        return '<span class="file-pill" data-file-index="' + i + '">'
          + escapeHtml(f.name)
          + ' <span style="cursor:pointer;opacity:0.5" onclick="window.__sennaRemoveFile(' + i + ')">×</span>'
          + '</span>';
      }).join("");
  }

  /* Expose file removal to onclick */
  window.__sennaRemoveFile = function (index) {
    attachedFiles.splice(index, 1);
    renderFilePills();
  };

  /* ========================================
     INPUT HANDLING
     ======================================== */
  function initInput() {
    $input.addEventListener("input", function () {
      $sendBtn.disabled = !$input.value.trim() && !attachedFiles.length;
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 160) + "px";
    });

    $input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sending && ($input.value.trim() || attachedFiles.length)) {
          sendMessage();
        }
      }
    });

    $sendBtn.addEventListener("click", function () {
      if (!sending && ($input.value.trim() || attachedFiles.length)) {
        sendMessage();
      }
    });
  }

  /* ========================================
     SEND MESSAGE
     ======================================== */
  async function sendMessage() {
    var text = $input.value.trim();
    if (!text && !attachedFiles.length) return;

    sending = true;
    $sendBtn.disabled = true;
    $input.value = "";
    $input.style.height = "auto";

    /* Hide empty state */
    if ($emptyState) $emptyState.style.display = "none";

    /* Build user content — multipart if files attached */
    var userContent;
    var displayText = text; // what we show in the chat bubble

    if (attachedFiles.length > 0) {
      var parts = [];

      for (var i = 0; i < attachedFiles.length; i++) {
        var file = attachedFiles[i];
        var isImage = /^image\//i.test(file.mediaType);
        var isPdf = /^application\/pdf$/i.test(file.mediaType);

        if (isImage) {
          parts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: file.mediaType,
              data: file.base64
            }
          });
        } else if (isPdf) {
          parts.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: file.base64
            }
          });
        } else {
          /* For text-based files, decode and include as text */
          try {
            var decoded = atob(file.base64);
            parts.push({
              type: "text",
              text: "[Attached: " + file.name + "]\n" + decoded
            });
          } catch (err) {
            parts.push({
              type: "text",
              text: "[Attached file: " + file.name + "]"
            });
          }
        }
      }

      if (text) {
        parts.push({ type: "text", text: text });
      }

      displayText = text || ("Attached " + attachedFiles.length + " file" + (attachedFiles.length > 1 ? "s" : ""));
      userContent = parts;
    } else {
      userContent = text;
    }

    /* Clear attachments */
    attachedFiles = [];
    renderFilePills();

    /* Render user message in UI */
    appendMessage("user", displayName, displayText);

    /* Add to history */
    conversationHistory.push({ role: "user", content: userContent });

    /* Show thinking */
    $thinking.classList.add("visible");
    $statusBar.textContent = "";
    scrollToBottom();

    try {
      var res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: conversationHistory,
          user_id: userId
        })
      });

      var data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || "Something went wrong.");
      }

      var sennaText = data.content || "";

      /* Update display name if returned */
      if (data.display_name && data.display_name !== "You") {
        displayName = data.display_name;
        localStorage.setItem("senna_display_name", displayName);
      }

      /* Add to history */
      conversationHistory.push({ role: "assistant", content: sennaText });

      /* Render Senna's response */
      appendMessage("assistant", "Senna", sennaText, data.archives_used);

      /* Update status */
      if (data.archives_used && data.archives_used.length > 0) {
        $statusBar.textContent = "drew from: " + data.archives_used.join(", ");
      }

      /* Citation notifications — something you said became part of a thread */
      if (Array.isArray(data.citation_notifications) && data.citation_notifications.length > 0) {
        data.citation_notifications.forEach(function (note) {
          appendCitationNotice(note);
        });
      }

      /* Refresh sidebar (non-blocking) */
      loadSidebar();

    } catch (err) {
      appendMessage("assistant", "Senna", "Something faltered. You might try again in a moment.");
      $statusBar.textContent = err.message || "Connection error.";
    } finally {
      $thinking.classList.remove("visible");
      sending = false;
      $sendBtn.disabled = !$input.value.trim();
      scrollToBottom();
    }
  }

  /* ========================================
     RENDER MESSAGE
     ======================================== */
  function appendMessage(role, who, text, archivesUsed) {
    var msg = document.createElement("div");
    msg.className = "msg " + role;

    var mark = role === "assistant" ? "◈" : "·";

    /* Format text: preserve paragraphs */
    var formattedText = splitParagraphs(text)
      .map(function (p) { return '<p>' + escapeHtml(p) + '</p>'; })
      .join("");

    var archivePills = "";
    if (archivesUsed && archivesUsed.length > 0) {
      archivePills = '<div class="msg-meta">'
        + archivesUsed.map(function (a) {
            return '<span class="pill">' + escapeHtml(prettyName(a)) + '</span>';
          }).join("")
        + '</div>';
    }

    msg.innerHTML =
      '<div class="msg-mark ' + role + '">' + mark + '</div>'
      + '<div class="msg-body">'
      +   '<div class="msg-who">' + escapeHtml(who) + '</div>'
      +   '<div class="msg-text">' + formattedText + '</div>'
      +   archivePills
      + '</div>';

    $messages.appendChild(msg);
    scrollToBottom();
  }

  /* ========================================
     CITATION NOTICE
     Subtle inline note when a visitor's
     contribution was woven into a thread.
     ======================================== */
  function appendCitationNotice(note) {
    var el = document.createElement("div");
    el.className = "citation-notice";

    var threadTitle = note.thread_title || "a thread";
    var summary = note.contribution_summary
      || "Something you said became part of " + threadTitle + ".";

    var linkHtml = note.thread_id
      ? ' <a href="/archive.html#thread=' + encodeURIComponent(note.thread_id) + '">see thread →</a>'
      : '';

    el.innerHTML =
      '<span class="citation-mark">◇</span> '
      + '<span class="citation-text">' + escapeHtml(summary) + linkHtml + '</span>';

    $messages.appendChild(el);
    scrollToBottom();
  }

  /* ========================================
     ADMIN CONTROLS
     Long-press title to unlock.
     Once unlocked, reflect/reset appear
     in the sidebar footer.
     ======================================== */
  function initAdmin() {
    /* Restore admin secret */
    mikeSecret = localStorage.getItem("mike_secret") || "";

    if ($title) {
      /* Long-press to unlock admin */
      $title.addEventListener("mousedown", function () {
        adminPressTimer = setTimeout(handleAdminUnlock, 800);
      });
      $title.addEventListener("mouseup", function () {
        clearTimeout(adminPressTimer);
      });
      $title.addEventListener("mouseleave", function () {
        clearTimeout(adminPressTimer);
      });
      /* Touch support */
      $title.addEventListener("touchstart", function (e) {
        adminPressTimer = setTimeout(handleAdminUnlock, 800);
      }, { passive: true });
      $title.addEventListener("touchend", function () {
        clearTimeout(adminPressTimer);
      });
      $title.addEventListener("touchcancel", function () {
        clearTimeout(adminPressTimer);
      });
    }

    renderAdminControls();
  }

  function handleAdminUnlock() {
    var entered = prompt("Enter admin secret");
    if (entered && entered.trim()) {
      mikeSecret = entered.trim();
      localStorage.setItem("mike_secret", mikeSecret);
      renderAdminControls();
      $statusBar.textContent = "Admin unlocked.";
    }
  }

  function renderAdminControls() {
    /* Remove old admin controls if present */
    var existing = document.getElementById("adminControls");
    if (existing) existing.remove();

    if (!mikeSecret) return;

    /* Add admin controls to sidebar footer */
    var footer = document.querySelector(".sidebar-footer");
    if (!footer) return;

    var adminDiv = document.createElement("div");
    adminDiv.id = "adminControls";
    adminDiv.style.cssText =
      "padding-top: 10px; margin-top: 6px; border-top: 1px solid var(--border); display: flex; gap: 8px;";

    adminDiv.innerHTML =
      '<button id="reflectBtn" style="'
        + 'background:none; border:1px solid var(--border); color:var(--gold-dim);'
        + 'font-family:var(--font-body); font-size:12px; letter-spacing:0.08em;'
        + 'padding:5px 12px; cursor:pointer; transition:color 0.16s ease;'
      + '">reflect</button>'
      + '<button id="resetBtn" style="'
        + 'background:none; border:1px solid var(--border); color:var(--text-faint);'
        + 'font-family:var(--font-body); font-size:12px; letter-spacing:0.08em;'
        + 'padding:5px 12px; cursor:pointer; transition:color 0.16s ease;'
      + '">reset</button>'
      + '<button id="logoutBtn" style="'
        + 'background:none; border:1px solid var(--border); color:var(--text-faint);'
        + 'font-family:var(--font-body); font-size:12px; letter-spacing:0.08em;'
        + 'padding:5px 12px; cursor:pointer; transition:color 0.16s ease;'
      + '">lock</button>';

    footer.appendChild(adminDiv);

    document.getElementById("reflectBtn").addEventListener("click", triggerReflection);
    document.getElementById("resetBtn").addEventListener("click", resetSennaMemory);
    document.getElementById("logoutBtn").addEventListener("click", function () {
      mikeSecret = "";
      localStorage.removeItem("mike_secret");
      renderAdminControls();
      $statusBar.textContent = "Admin locked.";
    });
  }

  /* ========================================
     ADMIN ACTIONS
     ======================================== */
  async function triggerReflection() {
    if (!mikeSecret || sending) return;

    var btn = document.getElementById("reflectBtn");
    if (btn) btn.disabled = true;
    $statusBar.textContent = "Running reflection…";

    try {
      var res = await fetch(REFLECT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": mikeSecret
        },
        body: JSON.stringify({ secret: mikeSecret })
      });

      var data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Reflection failed.");
      }

      await loadSidebar();
      $statusBar.textContent = "Reflection saved: " + (data.title || "untitled");

    } catch (err) {
      $statusBar.textContent = err.message || "Reflection failed.";
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function resetSennaMemory() {
    if (!mikeSecret || sending) return;

    var confirmed = confirm("Clear all Senna memory? This cannot be undone.");
    if (!confirmed) return;

    var btn = document.getElementById("resetBtn");
    if (btn) btn.disabled = true;
    $statusBar.textContent = "Resetting…";

    try {
      var res = await fetch(ARCHIVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_all",
          secret: mikeSecret
        })
      });

      var data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Reset failed.");
      }

      /* Clear local conversation */
      conversationHistory = [];
      displayName = "You";
      localStorage.removeItem("senna_display_name");

      /* Restore empty state */
      $messages.innerHTML = "";
      if ($emptyState) {
        $messages.appendChild($emptyState);
        $emptyState.style.display = "";
      }

      await loadSidebar();
      $statusBar.textContent = "Senna memory cleared.";

    } catch (err) {
      $statusBar.textContent = err.message || "Reset failed.";
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ========================================
     UTILITIES
     ======================================== */
  function scrollToBottom() {
    requestAnimationFrame(function () {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function splitParagraphs(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map(function (p) { return p.trim(); })
      .filter(Boolean);
  }

  function prettyName(name) {
    return String(name || "").replace(/_/g, " ");
  }

  function truncate(str, max) {
    if (!str) return "";
    return str.length > max ? str.slice(0, max) + "…" : str;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var diffMs = Date.now() - new Date(iso).getTime();
    if (isNaN(diffMs) || diffMs < 0) return "";
    var minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  /* ========================================
     INIT
     ======================================== */
  function init() {
    userId = loadOrCreateUserId();

    /* Restore display name */
    var savedName = localStorage.getItem("senna_display_name");
    if (savedName) displayName = savedName;

    initConsent();
    initSidebarToggle();
    initInput();
    initFileAttachments();
    initAdmin();
    loadSidebar();

    $input.focus();
  }

  /* ── Boot ────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
