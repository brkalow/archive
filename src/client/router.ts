type RouteHandler = (params: Record<string, string>) => void | Promise<void>;

interface Route {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];
  private notFoundHandler: RouteHandler = () => {
    const app = document.getElementById("app");
    if (app) {
      app.innerHTML = `
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <h1 class="text-2xl font-semibold mb-2">Page Not Found</h1>
          <p class="text-text-muted mb-4">The page you're looking for doesn't exist.</p>
          <a href="/" class="btn btn-primary">Go Home</a>
        </div>
      `;
    }
  };

  on(path: string, handler: RouteHandler) {
    const paramNames: string[] = [];
    const pattern = path
      .replace(/\//g, "\\/")
      .replace(/:([^/]+)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      });

    this.routes.push({
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    });
  }

  notFound(handler: RouteHandler) {
    this.notFoundHandler = handler;
  }

  private matchRoute(path: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  async navigate(path: string, replace = false) {
    if (replace) {
      history.replaceState(null, "", path);
    } else {
      history.pushState(null, "", path);
    }
    await this.handleRoute(path);
  }

  private async handleRoute(path: string) {
    const match = this.matchRoute(path);
    if (match) {
      await match.handler(match.params);
    } else {
      await this.notFoundHandler({});
    }
  }

  start() {
    // Handle initial route
    this.handleRoute(window.location.pathname);

    // Handle back/forward navigation
    window.addEventListener("popstate", () => {
      this.handleRoute(window.location.pathname);
    });

    // Intercept link clicks for client-side navigation
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest("a");

      if (
        link &&
        link.href &&
        link.origin === window.location.origin &&
        !link.hasAttribute("target") &&
        !link.hasAttribute("download") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        const url = new URL(link.href);
        this.navigate(url.pathname);
      }
    });
  }
}
