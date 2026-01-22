export function layout(title: string, content: string, extraHead: string = ""): string {
  return `<!DOCTYPE html>
<html lang="en" class="antialiased">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - openctl</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            'bg-primary': '#0c0c0c',
            'bg-secondary': '#141414',
            'bg-tertiary': '#1a1a1a',
            'bg-elevated': '#222222',
            'bg-hover': '#2a2a2a',
            'text-primary': '#e4e4e7',
            'text-secondary': '#a1a1aa',
            'text-muted': '#52525b',
            'accent-primary': '#67e8f9',
            'accent-secondary': '#c4b5fd',
          },
          fontFamily: {
            mono: ['"Berkeley Mono"', '"JetBrains Mono"', '"Fira Code"', 'monospace'],
          }
        }
      }
    }
  </script>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
  </style>
  ${extraHead}
</head>
<body class="bg-bg-primary text-text-primary min-h-screen">
  <header class="sticky top-0 z-50 bg-bg-secondary/95 backdrop-blur-sm border-b border-bg-elevated">
    <nav class="max-w-[1400px] mx-auto px-6 lg:px-10 flex items-center justify-between h-14">
      <a href="/" class="text-lg font-mono font-medium text-text-primary hover:text-accent-primary transition-colors">
        <span class="text-[11px] inline-flex gap-[2px] -translate-y-[1.5px]"><span>[</span><span>]</span></span>penctl
      </a>
      <a href="/stats" class="text-sm text-text-secondary hover:text-text-primary transition-colors">Stats</a>
    </nav>
  </header>
  <main>
    ${content}
  </main>
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
  } as const;
  return text.replace(/[&<>"']/g, (char) => map[char as keyof typeof map] ?? char);
}
