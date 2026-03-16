import { buildWaitingPageCsp } from "@/server/proxy/proxy-route-utils";
import { getWaitingPageHtml } from "@/server/proxy/waitingPage";

const RETRY_AFTER_SECONDS = 2;

export type GatewayPendingPayload = {
  error: {
    code: "SANDBOX_PENDING";
    message: string;
  };
  pending: {
    status: string;
    retryAfterMs: number;
    pollPath: string;
    gatewayPath: string;
    returnPath: string;
  };
};

/**
 * Returns true when the request is a browser page navigation (GET with
 * text/html accept or sec-fetch-dest=document).  Everything else —
 * POST /v1/chat/completions, XHR, curl, HEAD, etc. — gets JSON.
 */
export function requestPrefersHtml(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const secFetchDest = request.headers.get("sec-fetch-dest") ?? "";
  return (
    request.method === "GET" &&
    (secFetchDest === "document" || accept.includes("text/html"))
  );
}

/**
 * Build a pending response appropriate for the caller type:
 * - Browser navigation → 202 HTML waiting page
 * - HEAD → 503 with no body
 * - Everything else → 503 JSON with retry hints
 */
export function buildGatewayPendingResponse(options: {
  request: Request;
  returnPath: string;
  status: string;
  setCookieHeader?: string | null;
}): Response {
  const baseHeaders = new Headers({
    "Cache-Control": "no-store, private",
    "Retry-After": String(RETRY_AFTER_SECONDS),
    "X-Sandbox-Status": options.status,
  });

  let response: Response;

  if (options.request.method === "HEAD") {
    response = new Response(null, {
      status: 503,
      headers: baseHeaders,
    });
  } else if (requestPrefersHtml(options.request)) {
    response = new Response(
      getWaitingPageHtml(options.returnPath, options.status),
      {
        status: 202,
        headers: new Headers({
          ...Object.fromEntries(baseHeaders.entries()),
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": buildWaitingPageCsp(),
        }),
      },
    );
  } else {
    const payload: GatewayPendingPayload = {
      error: {
        code: "SANDBOX_PENDING",
        message: `Sandbox is ${options.status}. Retry the request after the gateway is running.`,
      },
      pending: {
        status: options.status,
        retryAfterMs: RETRY_AFTER_SECONDS * 1000,
        pollPath: "/api/status",
        gatewayPath: "/gateway",
        returnPath: options.returnPath,
      },
    };

    response = new Response(JSON.stringify(payload), {
      status: 503,
      headers: new Headers({
        ...Object.fromEntries(baseHeaders.entries()),
        "Content-Type": "application/json; charset=utf-8",
      }),
    });
  }

  if (options.setCookieHeader) {
    response.headers.append("Set-Cookie", options.setCookieHeader);
  }

  return response;
}
