import { Router } from "./router";
import { renderSessionList, renderSessionDetail, renderNotFound, renderSingleMessage, renderConnectionStatusHtml, renderDiffPanel, escapeHtml, renderFeedbackInput, renderSessionStatus, renderComponentsShowcase, renderGettingStarted, type FeedbackInputState } from "./views";
import { formatMarkdown } from "./blocks";
import type { Session, Message, Diff, Review, Annotation, AnnotationType } from "../db/schema";
// Import @pierre/diffs - this registers the web component and provides FileDiff class
import { FileDiff, getSingularPatch, File } from "@pierre/diffs";
import type { SupportedLanguages, DiffLineAnnotation } from "@pierre/diffs";
import { LiveSessionManager, isNearBottom, scrollToBottom } from "./liveSession";

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

// Track current live session manager
let liveSessionManager: LiveSessionManager | null = null;

// Live session state
let lastRenderedRole: string | null = null;
let pendingToolCalls = new Set<string>();

// Interactive session state
let interactiveState: FeedbackInputState = {
  isInteractive: false,
  claudeState: "unknown",
  sessionComplete: false,
  pendingFeedback: [],
};

// Toast notification system
declare global {
  interface Window {
    showToast: (message: string, type?: "success" | "error" | "info") => void;
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

async function fetchDiffs(sessionId: string): Promise<Diff[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diffs`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.diffs || [];
}

async function fetchAnnotations(sessionId: string): Promise<AnnotationsData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/annotations`);
  if (!res.ok) return null;
  return res.json();
}

// Route handlers
router.on("/", async () => {
  const app = document.getElementById("app")!;
  app.innerHTML = renderGettingStarted();
  attachGettingStartedHandlers();
});

router.on("/sessions", async () => {
  const app = document.getElementById("app")!;
  app.innerHTML = '<div class="text-center py-8 text-text-muted">Loading...</div>';

  const sessions = await fetchSessions();
  app.innerHTML = renderSessionList(sessions);
  attachSessionListHandlers();
});

router.on("/sessions/:id", async (params) => {
  // Clean up previous live session
  if (liveSessionManager) {
    liveSessionManager.destroy();
    liveSessionManager = null;
  }

  const app = document.getElementById("app")!;
  app.innerHTML = '<div class="text-center py-8 text-text-muted">Loading...</div>';

  const data = await fetchSessionDetail(params.id);
  if (!data) {
    app.innerHTML = renderNotFound();
    return;
  }

  app.innerHTML = renderSessionDetail(data);
  attachSessionDetailHandlers(data.session.id);

  // Initialize live session if status is live
  if (data.session.status === "live") {
    initializeLiveSession(data.session.id, data.messages, data.session);
  }
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

router.on("/_components", async () => {
  const app = document.getElementById("app")!;
  app.innerHTML = renderComponentsShowcase();
});

// Event handler attachments
function attachGettingStartedHandlers() {
  // Copy button handler for the install command
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
}

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
        // Check if the content should be formatted as markdown
        const useMarkdown = resultEl.dataset.formatMarkdown === "true";
        if (useMarkdown) {
          resultEl.innerHTML = formatMarkdown(fullContent);
        } else {
          resultEl.textContent = fullContent;
        }
        showAllBtn.remove();
      }
    }
  });
}

// Track FileDiff instances for cleanup
const diffInstances: FileDiff<AnnotationMetadata>[] = [];

// Track File instances for cleanup
const fileInstances: File[] = [];

// Track rendered diffs to avoid re-rendering
const renderedDiffs = new Set<string>();

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

// Store annotations data for use in renderDiffContent
let currentAnnotationsData: AnnotationsData | null = null;

async function initializeDiffs(sessionId: string) {
  // Clean up previous instances
  diffInstances.forEach((instance) => instance.cleanUp());
  diffInstances.length = 0;
  renderedDiffs.clear();

  // Fetch annotations for this session
  currentAnnotationsData = await fetchAnnotations(sessionId);

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
  const filename = container.dataset.filename || "file";
  const diffIdStr = container.dataset.diffId;
  const diffId = diffIdStr ? parseInt(diffIdStr, 10) : null;

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

    // Get annotations for this diff
    const annotationsByDiff = currentAnnotationsData?.annotations_by_diff || {};
    const reviewModel = currentAnnotationsData?.review?.model || null;
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

    // Create FileDiff instance with options
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
    const diffContainer = document.createElement("diffs-container");
    container.innerHTML = "";
    container.appendChild(diffContainer);

    // Render the diff with annotations
    diffInstance.render({
      fileDiff,
      fileContainer: diffContainer,
      lineAnnotations,
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

// Live session initialization
function initializeLiveSession(sessionId: string, initialMessages: Message[], session: Session): void {
  // Track the last rendered role for proper message grouping
  lastRenderedRole = initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].role : null;
  pendingToolCalls = new Set<string>();

  // Initialize interactive state from session data
  interactiveState = {
    isInteractive: session.interactive ?? false,
    claudeState: "unknown",
    sessionComplete: false,
    pendingFeedback: [],
  };

  // Build a set of all tool_use_ids and completed tool_result_ids in a single pass (O(n))
  const allToolUseIds = new Set<string>();
  const completedToolUseIds = new Set<string>();

  for (const msg of initialMessages) {
    if (msg.content_blocks) {
      for (const block of msg.content_blocks) {
        if (block.type === "tool_use") {
          allToolUseIds.add(block.id);
        } else if (block.type === "tool_result") {
          completedToolUseIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Pending = tool_use_ids that don't have a corresponding tool_result
  for (const id of allToolUseIds) {
    if (!completedToolUseIds.has(id)) {
      pendingToolCalls.add(id);
    }
  }

  // Show typing indicator if there are pending tool calls
  if (pendingToolCalls.size > 0) {
    showTypingIndicator();
  }

  const conversationList = document.getElementById("conversation-list");
  if (!conversationList) return;

  // Set up new messages button
  initNewMessagesButton(conversationList);

  // Initialize feedback input for interactive sessions
  if (interactiveState.isInteractive) {
    initializeFeedbackInput();
  }

  liveSessionManager = new LiveSessionManager(sessionId, {
    onMessage: (messages, _index) => {
      for (const message of messages) {
        // Track pending tool calls from assistant messages
        if (message.role === "assistant" && message.content_blocks) {
          for (const block of message.content_blocks) {
            if (block.type === "tool_use") {
              pendingToolCalls.add(block.id);
            }
          }
        }

        // Clear pending tool calls when results arrive in user messages
        if (message.role === "user" && message.content_blocks) {
          for (const block of message.content_blocks) {
            if (block.type === "tool_result") {
              pendingToolCalls.delete(block.tool_use_id);
            }
          }
        }

        // Render and append the message
        const html = renderSingleMessage(message, lastRenderedRole);
        if (html) {
          // Insert before typing indicator
          const typingIndicator = document.getElementById("typing-indicator");
          if (typingIndicator) {
            typingIndicator.insertAdjacentHTML("beforebegin", html);
          } else {
            conversationList.insertAdjacentHTML("beforeend", html);
          }

          lastRenderedRole = message.role;

          // Update message count
          updateMessageCount();

          // Handle auto-scroll
          if (isNearBottom(conversationList)) {
            scrollToBottom(conversationList);
            hideNewMessagesButton();
          } else {
            showNewMessagesButton();
          }
        }
      }

      // Update typing indicator based on final pending state after processing all messages
      if (pendingToolCalls.size > 0) {
        showTypingIndicator();
      } else {
        hideTypingIndicator();
      }

      // For interactive sessions, when we receive a user message with text content,
      // it means feedback was processed - clear any stale pending items and update UI
      if (interactiveState.isInteractive) {
        // Only treat as feedback if the user message has text content (not just tool results)
        const hasUserFeedback = messages.some(m =>
          m.role === "user" &&
          m.content_blocks?.some(block => block.type === "text")
        );
        if (hasUserFeedback && interactiveState.pendingFeedback.length > 0) {
          // Mark oldest pending item as approved if we haven't received explicit status
          const pendingItem = interactiveState.pendingFeedback.find(f => f.status === "pending");
          if (pendingItem) {
            // Use immutable update to avoid direct state mutation
            interactiveState.pendingFeedback = interactiveState.pendingFeedback.map(f =>
              f.id === pendingItem.id ? { ...f, status: "approved" as const } : f
            );
            // Remove after a short delay
            setTimeout(() => {
              interactiveState.pendingFeedback = interactiveState.pendingFeedback.filter(f => f.id !== pendingItem.id);
              updateFeedbackInput();
            }, 1000);
          }
        }
        updateFeedbackInput();
      }
    },

    onToolResult: (result) => {
      // Remove from pending
      pendingToolCalls.delete(result.tool_use_id);

      // Update the tool call in the DOM
      updateToolResult(result.tool_use_id, result.content, result.is_error);

      // Hide typing indicator if no more pending
      if (pendingToolCalls.size === 0) {
        hideTypingIndicator();
      }
    },

    onDiff: async (_files) => {
      // Fetch and re-render diffs
      const diffs = await fetchDiffs(sessionId);
      const diffPanelContainer = document.querySelector('[data-diff-panel]') as HTMLElement;
      const contentGrid = document.querySelector('[data-content-grid]') as HTMLElement;
      const conversationPanel = document.querySelector('[data-conversation-panel]') as HTMLElement;

      if (diffPanelContainer && diffs.length > 0) {
        // Check if this is the first diff (panel was hidden)
        const wasHidden = diffPanelContainer.classList.contains('hidden');

        // Update the panel content
        diffPanelContainer.innerHTML = renderDiffPanel(diffs);

        // If this is the first diff, animate the panel in
        if (wasHidden) {
          // Update grid to two-column layout
          if (contentGrid) {
            contentGrid.classList.remove('single-column');
            contentGrid.classList.add('two-column');
          }

          // Remove full-width from conversation panel
          if (conversationPanel) {
            conversationPanel.classList.remove('full-width');
          }

          // Trigger the slide-in animation (use requestAnimationFrame to ensure DOM has updated)
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              diffPanelContainer.classList.remove('hidden');
              diffPanelContainer.classList.add('visible');
            });
          });
        }

        // Re-attach diff toggle handlers
        attachDiffToggleHandlers();

        // Render diff content for non-collapsed diffs
        diffPanelContainer.querySelectorAll("[data-diff-content]").forEach((el) => {
          const htmlEl = el as HTMLElement;
          // Only render if not collapsed (needs-render=false means it should be visible)
          if (htmlEl.dataset.needsRender !== "true") {
            renderDiffContent(htmlEl);
          }
        });

        // Flash to indicate update
        const newDiffPanel = document.getElementById("diffs-container");
        if (newDiffPanel) {
          newDiffPanel.classList.add("diff-update-flash");
          setTimeout(() => newDiffPanel.classList.remove("diff-update-flash"), 500);
        }
      }
    },

    onComplete: () => {
      // Update header to show completed status
      updateSessionStatus("complete");
      hideTypingIndicator();
      // Update interactive state
      interactiveState.sessionComplete = true;
      updateFeedbackInput();
    },

    onConnectionChange: (connected) => {
      updateConnectionStatus(connected);
    },

    onReconnectAttempt: (attempt, maxAttempts) => {
      updateConnectionStatus(false);
      // Update status to show reconnection attempt
      const container = document.getElementById("connection-status");
      if (container) {
        container.innerHTML = `
          <span class="flex items-center gap-1 text-xs text-yellow-500">
            <span class="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></span>
            <span>Reconnecting (${attempt}/${maxAttempts})...</span>
          </span>
        `;
      }
    },

    onReconnectFailed: () => {
      const container = document.getElementById("connection-status");
      if (container) {
        container.innerHTML = `
          <span class="flex items-center gap-1 text-xs text-red-500">
            <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
            <span>Disconnected - <button onclick="location.reload()" class="underline hover:no-underline">Reload</button></span>
          </span>
        `;
      }
    },

    // Interactive session callbacks
    onInteractiveInfo: (interactive, claudeState) => {
      interactiveState.isInteractive = interactive;
      interactiveState.claudeState = claudeState;
      if (interactive) {
        initializeFeedbackInput();
      }
      updateFeedbackInput();
    },

    onClaudeState: (state) => {
      interactiveState.claudeState = state;
      updateFeedbackInput();
    },

    onFeedbackQueued: (messageId, position) => {
      interactiveState.pendingFeedback.push({ id: messageId, status: "pending" });
      updateFeedbackInput();
      window.showToast(`Message queued (position: ${position})`, "info");
    },

    onFeedbackStatus: (messageId, status) => {
      // Update the feedback status
      const feedback = interactiveState.pendingFeedback.find(f => f.id === messageId);
      if (feedback) {
        feedback.status = status === "expired" ? "rejected" : status;
      }
      updateFeedbackInput();

      // Show toast based on status
      if (status === "approved") {
        window.showToast("Message sent to session", "success");
      } else if (status === "rejected") {
        window.showToast("Message was declined", "error");
      } else if (status === "expired") {
        window.showToast("Message expired", "error");
      }

      // Remove from pending after a delay
      setTimeout(() => {
        interactiveState.pendingFeedback = interactiveState.pendingFeedback.filter(f => f.id !== messageId);
        updateFeedbackInput();
      }, 3000);
    },

    onOutput: (_data) => {
      // Terminal output - could be used for live terminal view in the future
      // For now, we just log it
    },
  });

  liveSessionManager.connect();
}

// Initialize feedback input UI
function initializeFeedbackInput(): void {
  const placeholder = document.getElementById("feedback-input-placeholder");
  if (!placeholder) return;

  updateFeedbackInput();
  attachFeedbackInputHandlers();
}

// Update feedback input UI based on current state
function updateFeedbackInput(): void {
  const placeholder = document.getElementById("feedback-input-placeholder");
  if (!placeholder) return;

  placeholder.innerHTML = renderFeedbackInput(interactiveState);
  attachFeedbackInputHandlers();
}

// Attach event handlers to feedback input
function attachFeedbackInputHandlers(): void {
  const input = document.getElementById("feedback-input") as HTMLTextAreaElement | null;
  const submitBtn = document.getElementById("feedback-submit");

  if (input) {
    // Remove existing listeners by replacing the element
    const newInput = input.cloneNode(true) as HTMLTextAreaElement;
    input.parentNode?.replaceChild(newInput, input);

    // Handle Ctrl+Enter or Cmd+Enter to submit
    newInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitFeedback();
      }
    });

    // Auto-resize textarea
    newInput.addEventListener("input", () => {
      newInput.style.height = "auto";
      newInput.style.height = Math.min(newInput.scrollHeight, 150) + "px";
    });
  }

  if (submitBtn) {
    // Remove existing listeners by replacing the element
    const newBtn = submitBtn.cloneNode(true);
    submitBtn.parentNode?.replaceChild(newBtn, submitBtn);

    newBtn.addEventListener("click", () => submitFeedback());
  }
}

// Submit feedback to the session
function submitFeedback(): void {
  const input = document.getElementById("feedback-input") as HTMLTextAreaElement | null;
  if (!input || !input.value.trim() || !liveSessionManager) return;

  const content = input.value.trim();
  input.value = "";
  input.style.height = "auto";

  liveSessionManager.sendFeedback(content);
}

function updateMessageCount(): void {
  const countEl = document.getElementById("message-count");
  if (countEl) {
    const messages = document.querySelectorAll("[data-message-index]");
    countEl.textContent = `${messages.length} messages`;
  }
}

function updateConnectionStatus(connected: boolean): void {
  const container = document.getElementById("connection-status");
  if (container) {
    container.innerHTML = renderConnectionStatusHtml(connected);
  }
}

function updateSessionStatus(status: string): void {
  // Remove live indicator
  const liveIndicator = document.querySelector(".live-indicator");
  if (liveIndicator) {
    liveIndicator.remove();
  }

  // Remove connection status
  const connectionStatus = document.getElementById("connection-status");
  if (connectionStatus) {
    const separator = connectionStatus.nextElementSibling;
    if (separator?.classList.contains("text-text-muted/30")) {
      separator.remove();
    }
    connectionStatus.remove();
  }
}

function updateToolResult(toolUseId: string, _content: string, isError?: boolean): void {
  // Find the tool call element by data-tool-id attribute
  const toolCall = document.querySelector(`[data-tool-id="${toolUseId}"]`);
  if (!toolCall) return;

  // Update status indicator in the header
  const header = toolCall.querySelector(".tool-header");
  if (header) {
    // Replace the status span (look for check, x, or ellipsis)
    const statusSpan = header.querySelector(".tool-status");
    if (statusSpan) {
      statusSpan.outerHTML = isError
        ? '<span class="tool-status text-red-500 font-medium">✗</span>'
        : '<span class="tool-status text-green-500 font-medium">✓</span>';
    }
  }

  // The full tool result will be part of the next message, so we don't need to add it here
}

function showTypingIndicator(): void {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.classList.remove("hidden");
    // Scroll to show typing indicator if near bottom
    const container = indicator.parentElement;
    if (container && isNearBottom(container)) {
      scrollToBottom(container);
    }
  }
}

function hideTypingIndicator(): void {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.classList.add("hidden");
  }
}

function showNewMessagesButton(): void {
  const btn = document.getElementById("new-messages-btn");
  if (btn) {
    btn.classList.remove("hidden");
  }
}

function hideNewMessagesButton(): void {
  const btn = document.getElementById("new-messages-btn");
  if (btn) {
    btn.classList.add("hidden");
  }
}

function initNewMessagesButton(scrollContainer: HTMLElement): void {
  const btn = document.getElementById("new-messages-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      scrollToBottom(scrollContainer);
      hideNewMessagesButton();
    });
  }

  // Hide button when user scrolls to bottom
  scrollContainer.addEventListener("scroll", () => {
    if (isNearBottom(scrollContainer)) {
      hideNewMessagesButton();
    }
  });
}

// Start the router
router.start();
