/**
 * Component Model Base
 *
 * A simple component model that co-locates views with their event handlers.
 * Each component returns HTML and can register event handlers that will be
 * executed on the client side.
 */

export interface EventHandler {
  selector: string;
  event: string;
  handler: string; // JavaScript function body as string
}

export interface ComponentResult {
  html: string;
  handlers: EventHandler[];
}

export interface Component<T = void> {
  (props: T): ComponentResult;
}

/**
 * Helper to escape HTML entities
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

/**
 * Combine multiple component results into one
 */
export function combineComponents(...components: ComponentResult[]): ComponentResult {
  return {
    html: components.map(c => c.html).join(""),
    handlers: components.flatMap(c => c.handlers),
  };
}

/**
 * Generate client-side JavaScript for event handlers
 */
export function generateClientScript(handlers: EventHandler[]): string {
  if (handlers.length === 0) return "";

  const handlerCode = handlers.map((h, i) => `
    // Handler ${i + 1}: ${h.event} on ${h.selector}
    document.querySelectorAll('${h.selector}').forEach(el => {
      el.addEventListener('${h.event}', function(e) {
        ${h.handler}
      });
    });
  `).join("\n");

  return `
<script type="module">
// Component Event Handlers
document.addEventListener('DOMContentLoaded', () => {
${handlerCode}
});
</script>`;
}
