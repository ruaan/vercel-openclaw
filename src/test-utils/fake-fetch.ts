/**
 * Configurable fetch mock for scenario tests.
 *
 * Intercepts gateway probe requests, upstream proxy responses,
 * and platform API calls (Slack, Telegram, Discord) so tests
 * run without any real network.
 */

export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

type RouteEntry = {
  pattern: string | RegExp;
  handler: FetchHandler;
};

/**
 * A programmable fetch replacement for scenario tests.
 *
 * Usage:
 * ```ts
 * const fake = createFakeFetch();
 * fake.onGet(/openclaw-app/, () => new Response("<html>openclaw-app</html>"));
 * fake.onPost("https://slack.com/api/chat.postMessage", () => Response.json({ ok: true }));
 * ```
 */
export type FakeFetch = {
  /** The fetch function to pass to adapters or install globally. */
  fetch: typeof globalThis.fetch;

  /** Register a handler for GET requests matching the pattern. */
  onGet(pattern: string | RegExp, handler: FetchHandler): void;

  /** Register a handler for POST requests matching the pattern. */
  onPost(pattern: string | RegExp, handler: FetchHandler): void;

  /** Register a handler for PATCH requests matching the pattern. */
  onPatch(pattern: string | RegExp, handler: FetchHandler): void;

  /** Register a handler for any method matching the pattern. */
  on(method: string, pattern: string | RegExp, handler: FetchHandler): void;

  /** Register a catch-all handler for unmatched requests. */
  otherwise(handler: FetchHandler): void;

  /** Return all captured requests as `{ url, method, body? }` records. */
  requests(): CapturedRequest[];

  /** Clear all handlers and captured requests. */
  reset(): void;
};

export type CapturedRequest = {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
};

function matchesPattern(url: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return url.includes(pattern);
  }
  return pattern.test(url);
}

export function createFakeFetch(): FakeFetch {
  const routes = new Map<string, RouteEntry[]>();
  let fallback: FetchHandler | null = null;
  const captured: CapturedRequest[] = [];

  function addRoute(method: string, pattern: string | RegExp, handler: FetchHandler): void {
    const key = method.toUpperCase();
    const existing = routes.get(key) ?? [];
    existing.push({ pattern, handler });
    routes.set(key, existing);
  }

  const fakeFetch: typeof globalThis.fetch = async (input, init?) => {
    const isRequest = input instanceof Request;

    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : isRequest
          ? input.url
          : String(input);

    // init.method takes precedence, then Request.method, then default GET
    const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();

    // init.body takes precedence, then Request body (consumed as text)
    let bodyText: string | undefined;
    if (init?.body) {
      bodyText = typeof init.body === "string"
        ? init.body
        : undefined;
    } else if (isRequest && input.body) {
      try {
        bodyText = await input.clone().text();
      } catch {
        // non-text body — leave undefined
      }
    }

    const headerRecord: Record<string, string> = {};
    // Resolve headers: init.headers > Request.headers > empty
    const rawHeaders = init?.headers ?? (isRequest ? input.headers : undefined);
    if (rawHeaders) {
      const h = rawHeaders;
      if (h instanceof Headers) {
        h.forEach((value, key) => {
          headerRecord[key] = value;
        });
      } else if (Array.isArray(h)) {
        for (const [key, value] of h) {
          headerRecord[key] = value;
        }
      } else {
        Object.assign(headerRecord, h);
      }
    }

    captured.push({ url, method, body: bodyText, headers: headerRecord });

    const methodRoutes = routes.get(method) ?? [];
    for (const route of methodRoutes) {
      if (matchesPattern(url, route.pattern)) {
        return route.handler(url, init);
      }
    }

    // Also check ANY-method routes
    const anyRoutes = routes.get("*") ?? [];
    for (const route of anyRoutes) {
      if (matchesPattern(url, route.pattern)) {
        return route.handler(url, init);
      }
    }

    if (fallback) {
      return fallback(url, init);
    }

    return new Response("fake-fetch: no handler matched", { status: 599 });
  };

  return {
    fetch: fakeFetch,

    onGet(pattern, handler) {
      addRoute("GET", pattern, handler);
    },

    onPost(pattern, handler) {
      addRoute("POST", pattern, handler);
    },

    onPatch(pattern, handler) {
      addRoute("PATCH", pattern, handler);
    },

    on(method, pattern, handler) {
      addRoute(method, pattern, handler);
    },

    otherwise(handler) {
      fallback = handler;
    },

    requests() {
      return [...captured];
    },

    reset() {
      routes.clear();
      fallback = null;
      captured.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Presets for common upstream responses
// ---------------------------------------------------------------------------

/** A gateway probe response that indicates the sandbox is ready. */
export function gatewayReadyResponse(): Response {
  return new Response(
    '<html><body><div id="openclaw-app">ready</div></body></html>',
    {
      status: 200,
      headers: { "content-type": "text/html" },
    },
  );
}

/** A gateway probe response that indicates the sandbox is not ready. */
export function gatewayNotReadyResponse(): Response {
  return new Response("<html><body>loading...</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

/** A Slack API success response. */
export function slackOkResponse(): Response {
  return Response.json({ ok: true });
}

/** A Telegram API success response. */
export function telegramOkResponse(): Response {
  return Response.json({ ok: true, result: { message_id: 1 } });
}

/** A Discord interaction webhook success response. */
export function discordOkResponse(): Response {
  return new Response(null, { status: 204 });
}

/** A gateway /v1/chat/completions response with a simple assistant reply. */
export function chatCompletionsResponse(content = "Hello from OpenClaw"): Response {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  });
}
