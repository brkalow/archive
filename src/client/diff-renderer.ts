/**
 * Diff Renderer - renders git diffs with line numbers and syntax highlighting
 */

type LineType = "addition" | "deletion" | "context" | "hunk" | "meta";

interface LineStyle {
  bg: string;
  text: string;
  indicator: string;
}

const styles: Record<LineType, LineStyle> = {
  addition: {
    bg: "background: rgba(0, 202, 177, 0.1);",
    text: "color: #00cab1;",
    indicator: "+",
  },
  deletion: {
    bg: "background: rgba(255, 46, 63, 0.1);",
    text: "color: #ff2e3f;",
    indicator: "-",
  },
  context: {
    bg: "",
    text: "color: #adadb1;",
    indicator: " ",
  },
  hunk: {
    bg: "background: rgba(0, 159, 255, 0.05);",
    text: "color: #009fff;",
    indicator: "",
  },
  meta: {
    bg: "",
    text: "color: #84848a;",
    indicator: "",
  },
};

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

function getLineType(line: string): LineType {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

function renderLine(
  line: string,
  type: LineType,
  oldNum: number | string,
  newNum: number | string
): string {
  const style = styles[type];
  const content = type === "addition" || type === "deletion" ? line.slice(1) : line;

  return `
    <div class="diff-line" style="display: flex; ${style.bg}">
      <span class="line-num" style="width: 40px; text-align: right; padding-right: 8px; color: #84848a; user-select: none; flex-shrink: 0;">
        ${oldNum}
      </span>
      <span class="line-num" style="width: 40px; text-align: right; padding-right: 8px; color: #84848a; user-select: none; flex-shrink: 0;">
        ${newNum}
      </span>
      <span class="indicator" style="width: 16px; text-align: center; ${style.text} user-select: none; flex-shrink: 0;">
        ${style.indicator}
      </span>
      <span class="line-content" style="${style.text} white-space: pre; padding-right: 16px;">
        ${escapeHtml(content)}
      </span>
    </div>
  `;
}

export function renderDiff(content: string, _filename: string): string {
  const lines = content.split("\n");

  let html = '<div class="diff-lines">';

  let lineNumOld = 0;
  let lineNumNew = 0;

  for (const line of lines) {
    const type = getLineType(line);

    // Parse hunk header for line numbers
    if (type === "hunk") {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        lineNumOld = parseInt(match[1], 10) - 1;
        lineNumNew = parseInt(match[2], 10) - 1;
      }
    }

    // Track line numbers
    let oldNum: number | string = "";
    let newNum: number | string = "";

    if (type === "addition") {
      lineNumNew++;
      newNum = lineNumNew;
    } else if (type === "deletion") {
      lineNumOld++;
      oldNum = lineNumOld;
    } else if (type === "context") {
      lineNumOld++;
      lineNumNew++;
      oldNum = lineNumOld;
      newNum = lineNumNew;
    }

    html += renderLine(line, type, oldNum, newNum);
  }

  html += "</div>";
  return html;
}
