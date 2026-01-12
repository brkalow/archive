import { Router } from "./router";
import { renderSessionList, renderSessionDetail, renderNotFound } from "./views";
import type { Session, Message, Diff } from "../db/schema";
// Import @pierre/diffs - this registers the web component and provides FileDiff class
import { FileDiff, getSingularPatch } from "@pierre/diffs";

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
}

// Track FileDiff instances for cleanup
const diffInstances: FileDiff[] = [];

// Track rendered diffs to avoid re-rendering
const renderedDiffs = new Set<string>();

function initializeDiffs() {
  // Clean up previous instances
  diffInstances.forEach((instance) => instance.cleanUp());
  diffInstances.length = 0;
  renderedDiffs.clear();

  // Render only non-collapsed diffs initially (lazy loading for collapsed ones)
  document.querySelectorAll("[data-diff-content]").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const needsRender = htmlEl.dataset.needsRender;

    // Skip if this diff is collapsed and needs lazy rendering
    if (needsRender === "true") {
      return;
    }

    renderDiffContent(htmlEl);
  });

  // Attach toggle handlers
  attachDiffToggleHandlers();
}

function renderDiffContent(container: HTMLElement): boolean {
  const diffContent = container.dataset.diffContent;
  const containerId = container.id;

  if (!diffContent) {
    container.innerHTML = '<div class="p-4 text-text-muted text-sm">No diff content</div>';
    return false;
  }

  // Already rendered
  if (containerId && renderedDiffs.has(containerId)) {
    return true;
  }

  try {
    // Parse the patch to get FileDiffMetadata
    const fileDiff = getSingularPatch(diffContent);

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
    const diffContainer = document.createElement("diffs-container");
    container.innerHTML = "";
    container.appendChild(diffContainer);

    // Render the diff
    diffInstance.render({
      fileDiff,
      fileContainer: diffContainer,
    });

    diffInstances.push(diffInstance);
    if (containerId) {
      renderedDiffs.add(containerId);
    }
    return true;
  } catch (err) {
    console.error("Failed to render diff:", err);
    container.innerHTML = `
      <div class="p-4">
        <div class="flex items-center gap-2 text-text-muted mb-2">
          <span>⚠️</span>
          <span>Unable to render diff</span>
        </div>
        <button class="text-accent-primary text-sm hover:underline" data-show-raw-diff>
          Show raw diff
        </button>
        <pre class="hidden raw-diff mt-2 text-xs font-mono whitespace-pre-wrap bg-bg-primary p-2 rounded overflow-x-auto max-h-96 overflow-y-auto">${escapeHtmlForDiff(diffContent)}</pre>
      </div>
    `;
    return false;
  }
}

function escapeHtmlForDiff(str: string): string {
  const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return str.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

function attachDiffToggleHandlers() {
  // Individual diff collapse/expand toggle
  document.querySelectorAll("[data-toggle-diff]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const toggleBtn = e.currentTarget as HTMLElement;
      const contentId = toggleBtn.dataset.toggleDiff;
      if (!contentId) return;

      const content = document.getElementById(contentId);
      const icon = toggleBtn.querySelector(".toggle-icon");
      const collapseLabel = toggleBtn.querySelector(".collapse-label");

      if (content && icon) {
        const isHidden = content.classList.contains("hidden");
        content.classList.toggle("hidden");
        icon.textContent = isHidden ? "▼" : "▶";

        if (collapseLabel) {
          collapseLabel.textContent = isHidden ? "Hide" : "Show";
        }

        // Render diff content if expanding and not yet rendered
        if (isHidden && content.dataset.needsRender === "true") {
          renderDiffContent(content);
          content.dataset.needsRender = "false";
        }
      }
    });
  });

  // "Other branch changes" section toggle
  document.querySelectorAll("[data-toggle-other-diffs]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const content = document.getElementById("other-diffs-content");
      const icon = btn.querySelector(".toggle-icon");

      if (content && icon) {
        const isHidden = content.classList.contains("hidden");
        content.classList.toggle("hidden");
        icon.textContent = isHidden ? "▼" : "▶";

        // Render any unrendered diffs in this section when expanding
        if (isHidden) {
          content.querySelectorAll("[data-diff-content][data-needs-render='true']").forEach((el) => {
            const diffEl = el as HTMLElement;
            // Only render if the individual diff is not collapsed
            if (!diffEl.classList.contains("hidden")) {
              renderDiffContent(diffEl);
              diffEl.dataset.needsRender = "false";
            }
          });
        }
      }
    });
  });

  // Show raw diff fallback toggle
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.matches("[data-show-raw-diff]")) {
      const rawDiff = target.nextElementSibling;
      if (rawDiff) {
        rawDiff.classList.toggle("hidden");
        target.textContent = rawDiff.classList.contains("hidden") ? "Show raw diff" : "Hide raw diff";
      }
    }
  });
}

// Start the router
router.start();
