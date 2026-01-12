import { Router } from "./router";
import { renderSessionList, renderSessionDetail, renderNotFound, escapeHtml } from "./views";
import type { Session, Message, Diff, Review, Annotation, AnnotationType } from "../db/schema";
// Import @pierre/diffs - this registers the web component and provides FileDiff class
import { FileDiff, getSingularPatch, type DiffLineAnnotation } from "@pierre/diffs";

// Annotation metadata for rendering
interface AnnotationMetadata {
  id: number;
  type: AnnotationType;
  content: string;
  model: string | null;
  filename: string;
  lineNumber: number;
}

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

interface ReviewWithCount extends Review {
  annotation_count: number;
}

interface SessionDetailData {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: ReviewWithCount | null;
}

interface AnnotationsData {
  review: Review | null;
  annotations_by_diff: Record<number, Annotation[]>;
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

async function fetchAnnotations(sessionId: string): Promise<AnnotationsData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/annotations`);
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

  // Initialize diff rendering with annotations
  initializeDiffs(sessionId);
}

// Track FileDiff instances for cleanup
const diffInstances: FileDiff<AnnotationMetadata>[] = [];

// Annotation type config
const annotationConfig: Record<AnnotationType, { label: string; badgeClass: string }> = {
  suggestion: { label: "suggestion", badgeClass: "bg-accent-primary/20 text-accent-primary" },
  issue: { label: "issue", badgeClass: "bg-diff-del/20 text-diff-del" },
  praise: { label: "good", badgeClass: "bg-diff-add/20 text-diff-add" },
  question: { label: "question", badgeClass: "bg-accent-secondary/20 text-accent-secondary" },
};

// Create annotation element for @pierre/diffs
function createAnnotationElement(metadata: AnnotationMetadata): HTMLElement {
  const config = annotationConfig[metadata.type] || annotationConfig.suggestion;
  const locationText = `${metadata.filename}:${metadata.lineNumber}`;
  const copyText = `${locationText}\n\n${metadata.content}`;

  const wrapper = document.createElement("div");
  wrapper.className = "bg-bg-tertiary border border-bg-elevated rounded-lg p-4 my-3 mx-4";

  wrapper.innerHTML = `
    <div class="flex items-center gap-3 mb-3">
      <div class="w-8 h-8 rounded-full bg-gradient-to-br from-accent-secondary to-accent-primary flex items-center justify-center text-white text-sm font-semibold shrink-0">C</div>
      <span class="font-semibold text-text-primary">Claude</span>
      <span class="text-xs text-text-muted font-mono">${escapeHtml(locationText)}</span>
      <div class="ml-auto flex items-center gap-2">
        <span class="px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}">${config.label}</span>
        <button class="flex items-center gap-1.5 px-2 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-bg-elevated rounded transition-colors copy-btn">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          copy prompt
        </button>
      </div>
    </div>
    <p class="text-[15px] text-text-primary leading-relaxed font-sans">${escapeHtml(metadata.content)}</p>
  `;

  // Add copy handler
  const copyBtn = wrapper.querySelector(".copy-btn") as HTMLButtonElement | null;
  copyBtn?.addEventListener("click", async () => {
    const originalHtml = copyBtn.innerHTML;
    await window.copyToClipboard(copyText);
    copyBtn.innerHTML = `
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
      </svg>
      copied!
    `;
    setTimeout(() => {
      copyBtn.innerHTML = originalHtml;
    }, 1500);
  });

  return wrapper;
}

async function initializeDiffs(sessionId: string) {
  // Clean up previous instances
  diffInstances.forEach((instance) => instance.cleanUp());
  diffInstances.length = 0;

  // Fetch annotations for this session
  const annotationsData = await fetchAnnotations(sessionId);
  const annotationsByDiff = annotationsData?.annotations_by_diff || {};
  const reviewModel = annotationsData?.review?.model || null;

  document.querySelectorAll("[data-diff-content]").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const content = htmlEl.dataset.diffContent;
    const filename = htmlEl.dataset.filename || "file";
    const diffIdStr = htmlEl.dataset.diffId;
    const diffId = diffIdStr ? parseInt(diffIdStr, 10) : null;

    if (content) {
      try {
        // Parse the patch to get FileDiffMetadata
        const fileDiff = getSingularPatch(content);

        // Get annotations for this diff
        const annotations = diffId ? (annotationsByDiff[diffId] || []) : [];

        // Convert to @pierre/diffs format
        const lineAnnotations: DiffLineAnnotation<AnnotationMetadata>[] = annotations.map((a) => ({
          side: a.side as "additions" | "deletions",
          lineNumber: a.line_number,
          metadata: {
            id: a.id,
            type: a.annotation_type,
            content: a.content,
            model: reviewModel,
            filename,
            lineNumber: a.line_number,
          },
        }));

        // Create FileDiff instance with annotation rendering
        const diffInstance = new FileDiff<AnnotationMetadata>({
          theme: { dark: "pierre-dark", light: "pierre-light" },
          themeType: "dark",
          diffStyle: "unified",
          diffIndicators: "classic",
          disableFileHeader: true,
          overflow: "scroll",
          renderAnnotation: (annotation) => createAnnotationElement(annotation.metadata),
        });

        // Create a container element
        const container = document.createElement("diffs-container");
        htmlEl.innerHTML = "";
        htmlEl.appendChild(container);

        // Render the diff with annotations
        diffInstance.render({
          fileDiff,
          fileContainer: container,
          lineAnnotations,
        });

        diffInstances.push(diffInstance);
      } catch (err) {
        console.error("Failed to render diff:", err);
        htmlEl.innerHTML = `<pre class="p-3 text-diff-del text-sm">Failed to render diff</pre>`;
      }
    }
  });
}

// Start the router
router.start();
