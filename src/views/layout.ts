export function layout(title: string, content: string, extraHead: string = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Claude Session Archive</title>
  <link rel="stylesheet" href="/css/style.css">
  ${extraHead}
</head>
<body>
  <header>
    <nav>
      <a href="/" class="logo">Claude Session Archive</a>
    </nav>
  </header>
  <main>
    ${content}
  </main>
  <script src="/js/app.js"></script>
</body>
</html>`;
}

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
