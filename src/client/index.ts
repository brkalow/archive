import { Router } from "./router";
import { renderSessionList, renderSessionDetail, renderNotFound } from "./views";
import type { Session, Message, Diff } from "../db/schema";
// Import @pierre/diffs - this registers the web component and provides FileDiff class
import { FileDiff, getSingularPatch, File } from "@pierre/diffs";
import type { SupportedLanguages } from "@pierre/diffs";

// Initialize router
const router = new Router();

// Toast notification system
declare global {
  interface Window {
    showToast: (message: string, type?: "success" | "error") => void;
    copyToClipboard: (text: string) => Promise<void>;
  }
}

window.showToast = (message: string, type = "success") => {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(1rem)";
    setTimeout(() => toast.remove(), 200);
  }, 3000);
};

window.copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    window.showToast("Copied to clipboard");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    window.showToast("Copied to clipboard");
  }
};

// API helpers
async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions || [];
}

interface SessionDetailData {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
}

async function fetchSessionDetail(id: string): Promise<SessionDetailData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchSharedSession(shareToken: string): Promise<SessionDetailData | null> {
  const res = await fetch(`/api/s/${encodeURIComponent(shareToken)}`);
  if (!res.ok) return null;
  return res.json();
}

// Route handlers
router.on("/", async () => {
  const app = document.getElementById("app")!;
  app.innerHTML = '<div class="text-center py-8 text-text-muted">Loading...</div>';

  const sessions = await fetchSessions();
  app.innerHTML = renderSessionList(sessions);
  attachSessionListHandlers();
});

router.on("/sessions/:id", async (params) => {
  const app = document.getElementById("app")!;
  app.innerHTML = '<div class="text-center py-8 text-text-muted">Loading...</div>';

  const data = await fetchSessionDetail(params.id);
  if (!data) {
    app.innerHTML = renderNotFound();
    return;
  }

  app.innerHTML = renderSessionDetail(data);
  attachSessionDetailHandlers(data.session.id);
});

router.on("/s/:shareToken", async (params) => {
  const app = document.getElementById("app")!;
  app.innerHTML = '<div class="text-center py-8 text-text-muted">Loading...</div>';

  const data = await fetchSharedSession(params.shareToken);
  if (!data) {
    app.innerHTML = renderNotFound();
    return;
  }

  app.innerHTML = renderSessionDetail(data);
  attachSessionDetailHandlers(data.session.id);
});

// Event handler attachments
function attachSessionListHandlers() {
  const searchInput = document.getElementById("search-input") as HTMLInputElement;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value.toLowerCase();
      document.querySelectorAll("[data-session-card]").forEach((card) => {
        const el = card as HTMLElement;
        const title = card.querySelector("[data-title]")?.textContent?.toLowerCase() || "";
        const description = card.querySelector("[data-description]")?.textContent?.toLowerCase() || "";
        const project = card.querySelector("[data-project]")?.textContent?.toLowerCase() || "";
        const matches = title.includes(query) || description.includes(query) || project.includes(query);
        el.style.display = matches ? "" : "none";
      });
    });
  }
}

function attachSessionDetailHandlers(sessionId: string) {
  // Copy buttons with data-copy-target pattern
  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const copyBtn = btn as HTMLElement;
      const targetId = copyBtn.dataset.copyTarget;
      const targetEl = document.getElementById(targetId!);

      if (targetEl) {
        const text = targetEl.textContent?.trim() || "";
        await window.copyToClipboard(text);

        // Show feedback
        copyBtn.classList.add("text-diff-add");
        setTimeout(() => copyBtn.classList.remove("text-diff-add"), 1000);
      }
    });
  });

  // Share session
  document.querySelectorAll("[data-share-session]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
          method: "POST",
        });
        if (res.ok) {
          router.navigate(window.location.pathname);
        } else {
          window.showToast("Failed to create share link", "error");
        }
      } catch {
        window.showToast("Failed to create share link", "error");
      }
    });
  });

  // Initialize diff rendering
  initializeDiffs();

  // Initialize code block syntax highlighting
  initializeCodeBlocks();

  // Attach block interaction handlers
  attachBlockHandlers();
}

function attachBlockHandlers() {
  // Tool/thinking block collapse/expand toggle
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const toggleBtn = target.closest("[data-toggle-tool]") as HTMLElement;

    if (toggleBtn) {
      const contentId = toggleBtn.dataset.toggleTool;
      const content = document.getElementById(contentId!);
      const icon = toggleBtn.querySelector(".toggle-icon");

      if (content && icon) {
        const isHidden = content.classList.contains("hidden");
        content.classList.toggle("hidden");
        // Toggle between right-pointing (collapsed) and down-pointing (expanded) triangles
        icon.innerHTML = isHidden ? "&#9660;" : "&#9654;";
      }
    }
  });

  // Copy message handler
  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest(".copy-message") as HTMLElement;

    if (copyBtn) {
      const message = copyBtn.closest(".message");
      if (message) {
        // Get text content only (from text-block elements, exclude tool blocks)
        const textBlocks = message.querySelectorAll(".text-block");
        const text = Array.from(textBlocks)
          .map((b) => b.textContent)
          .join("\n")
          .trim();

        if (text) {
          await window.copyToClipboard(text);
          copyBtn.classList.add("text-diff-add");
          setTimeout(() => copyBtn.classList.remove("text-diff-add"), 1000);
        }
      }
    }
  });

  // Copy code block handler
  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest(".copy-code") as HTMLElement;

    if (copyBtn) {
      const pre = copyBtn.closest("pre");
      const code = pre?.querySelector("code");
      if (code) {
        await window.copyToClipboard(code.textContent || "");
        copyBtn.classList.add("text-diff-add");
        setTimeout(() => copyBtn.classList.remove("text-diff-add"), 1000);
      }
    }
  });

  // Copy tool result handler
  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest("[data-copy-result]") as HTMLElement;

    if (copyBtn) {
      const resultId = copyBtn.dataset.copyResult;
      const resultEl = document.getElementById(resultId!);
      if (resultEl) {
        await window.copyToClipboard(resultEl.textContent || "");
        copyBtn.classList.add("text-diff-add");
        setTimeout(() => copyBtn.classList.remove("text-diff-add"), 1000);
      }
    }
  });

  // Show all result handler
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const showAllBtn = target.closest("[data-show-all-result]") as HTMLElement;

    if (showAllBtn) {
      const resultId = showAllBtn.dataset.showAllResult;
      const fullContent = showAllBtn.dataset.fullContent;
      const resultEl = document.getElementById(resultId!);

      if (resultEl && fullContent) {
        resultEl.textContent = fullContent;
        showAllBtn.remove();
      }
    }
  });
}

// Track FileDiff instances for cleanup
const diffInstances: FileDiff[] = [];

// Track File instances for cleanup
const fileInstances: File[] = [];

function initializeDiffs() {
  // Clean up previous instances
  diffInstances.forEach((instance) => instance.cleanUp());
  diffInstances.length = 0;

  document.querySelectorAll("[data-diff-content]").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const content = htmlEl.dataset.diffContent;
    const filename = htmlEl.dataset.filename || "file";

    if (content) {
      try {
        // Parse the patch to get FileDiffMetadata
        const fileDiff = getSingularPatch(content);

        // Create FileDiff instance with options
        const diffInstance = new FileDiff({
          theme: { dark: "pierre-dark", light: "pierre-light" },
          themeType: "dark",
          diffStyle: "unified",
          diffIndicators: "classic",
          disableFileHeader: true,
          overflow: "scroll",
        });

        // Create a container element
        const container = document.createElement("diffs-container");
        htmlEl.innerHTML = "";
        htmlEl.appendChild(container);

        // Render the diff
        diffInstance.render({
          fileDiff,
          fileContainer: container,
        });

        diffInstances.push(diffInstance);
      } catch (err) {
        console.error("Failed to render diff:", err);
        htmlEl.innerHTML = `<pre class="p-3 text-diff-del text-sm">Failed to render diff</pre>`;
      }
    }
  });
}

function initializeCodeBlocks() {
  // Clean up previous instances
  fileInstances.forEach((instance) => instance.cleanUp());
  fileInstances.length = 0;

  document.querySelectorAll("[data-code-content]").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const encodedContent = htmlEl.dataset.codeContent;
    const language = htmlEl.dataset.language || "";

    if (encodedContent) {
      try {
        // Decode base64-encoded content
        const code = decodeURIComponent(atob(encodedContent));

        // Create File instance with options matching diff styling
        const fileInstance = new File({
          theme: { dark: "pierre-dark", light: "pierre-light" },
          themeType: "dark",
          overflow: "scroll",
          disableFileHeader: true,
        });

        // Create a container element for the highlighted code
        const container = document.createElement("diffs-container");

        // Check if this is a tool result content (has .tool-result-content class)
        const isToolResult = htmlEl.classList.contains("tool-result-content");

        // Preserve the copy button (different class for tool results vs code blocks)
        const copyBtn = htmlEl.querySelector(".copy-code");

        // For tool results, we need to preserve the pre element's id for copy functionality
        const preEl = htmlEl.querySelector("pre");
        const preId = preEl?.id;

        htmlEl.innerHTML = "";
        htmlEl.appendChild(container);

        // Re-add the copy button if it existed (for markdown code blocks)
        if (copyBtn) {
          container.appendChild(copyBtn);
        }

        // Render the highlighted code
        fileInstance.render({
          file: {
            name: "code",
            contents: code,
            lang: language as SupportedLanguages || undefined,
          },
          fileContainer: container,
        });

        // For tool results, add an id to the rendered content for copy functionality
        if (isToolResult && preId) {
          const renderedPre = container.querySelector("pre");
          if (renderedPre) {
            renderedPre.id = preId;
          }
        }

        fileInstances.push(fileInstance);
      } catch (err) {
        console.error("Failed to render code block:", err);
        // Leave the fallback content in place
      }
    }
  });
}

// Start the router
router.start();
