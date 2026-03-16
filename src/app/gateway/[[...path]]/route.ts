import { after } from "next/server";

import { requireAdminAuth } from "@/server/auth/admin-auth";
import { getPublicOrigin } from "@/server/public-url";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { injectWrapperScript } from "@/server/proxy/htmlInjection";
import { buildGatewayPendingResponse } from "@/server/proxy/pending-response";
import {
  buildSafeProxyHeaders,
  buildSandboxTargetUrl,
  buildTokenHtmlHeaders,
  isInvalidProxyTargetPath,
  normalizeProxyTargetPath,
  sanitizeProxyQueryParams,
  stripProxyResponseHeaders,
} from "@/server/proxy/proxy-route-utils";
import {
  ensureSandboxRunning,
  getSandboxDomain,
  reconcileSandboxHealth,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";

export const maxDuration = 300;

const NO_BODY_RESPONSE_STATUSES = new Set([204, 304]);

type Params = Promise<{ path?: string[] }>;

function buildTargetPath(path?: string[]): string {
  return normalizeProxyTargetPath(`/${path?.join("/") ?? ""}`);
}

function withSetCookie(response: Response, setCookieHeader: string | null): Response {
  if (setCookieHeader) {
    response.headers.append("Set-Cookie", setCookieHeader);
  }
  return response;
}

async function handleProxy(request: Request, path: string): Promise<Response> {
  const requestId = extractRequestId(request);
  const reqCtx: Record<string, unknown> = { path, method: request.method };
  if (requestId) reqCtx.requestId = requestId;

  if (isInvalidProxyTargetPath(path)) {
    logWarn("gateway.invalid_path", reqCtx);
    return new Response("Invalid path", { status: 400 });
  }

  const auth = await requireAdminAuth(request);
  if (auth instanceof Response) {
    logWarn("gateway.auth_failure", { ...reqCtx, status: auth.status });
    return auth;
  }

  const ensure = await ensureSandboxRunning({
    origin: getPublicOrigin(request),
    reason: "gateway.request",
    schedule: after,
  });
  const returnPath = `/gateway${path === "/" ? "" : path}`;

  if (ensure.state !== "running") {
    logInfo("gateway.pending", { ...reqCtx, sandboxStatus: ensure.meta.status });
    return buildGatewayPendingResponse({
      request,
      returnPath,
      status: ensure.meta.status,
      setCookieHeader: auth.setCookieHeader,
    });
  }

  const meta = await touchRunningSandbox();
  if (!meta.sandboxId || !meta.gatewayToken) {
    return buildGatewayPendingResponse({
      request,
      returnPath,
      status: meta.status,
      setCookieHeader: auth.setCookieHeader,
    });
  }

  const routeUrl = await getSandboxDomain();
  const queryString = sanitizeProxyQueryParams(new URL(request.url).searchParams);
  const targetUrl = buildSandboxTargetUrl(routeUrl, path, queryString);
  const headers = buildSafeProxyHeaders(request, targetUrl.toString(), {
    authorization: `Bearer ${meta.gatewayToken}`,
  });

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(maxDuration * 1000),
  };
  if (request.body && !["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    logError("gateway.upstream_fetch_failed", {
      ...reqCtx,
      error: err instanceof Error ? err.message : String(err),
    });
    return withSetCookie(
      new Response("Bad Gateway", { status: 502 }),
      auth.setCookieHeader,
    );
  }
  if (upstream.status === 410) {
    logWarn("gateway.upstream_410", reqCtx);
    await reconcileSandboxHealth({
      origin: getPublicOrigin(request),
      reason: "gateway.410",
      schedule: after,
    });
    return buildGatewayPendingResponse({
      request,
      returnPath,
      status: "restoring",
      setCookieHeader: auth.setCookieHeader,
    });
  }

  const responseHeaders = stripProxyResponseHeaders(upstream.headers, [meta.gatewayToken]);
  const locationHeader = responseHeaders.get("location");
  if (locationHeader) {
    const proxyOrigin = new URL(request.url).origin;
    if (locationHeader.startsWith("//")) {
      responseHeaders.delete("location");
      return withSetCookie(
        new Response(
          `<!DOCTYPE html><html><body><h1>Redirect blocked</h1><p><a href="${proxyOrigin}">Return</a></p></body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store, private",
            },
          },
        ),
        auth.setCookieHeader,
      );
    }

    try {
      const redirectUrl = new URL(locationHeader);
      if (redirectUrl.host === targetUrl.host) {
        responseHeaders.set(
          "location",
          `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`,
        );
      } else {
        responseHeaders.delete("location");
      }
    } catch {
      // Ignore relative redirects.
    }
  }

  if (responseHeaders.has("location")) {
    return withSetCookie(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
      auth.setCookieHeader,
    );
  }

  if (NO_BODY_RESPONSE_STATUSES.has(upstream.status)) {
    return withSetCookie(
      new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
      auth.setCookieHeader,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    logInfo("gateway.html_injection", { ...reqCtx, upstreamStatus: upstream.status });
    const html = await upstream.text();
    const sandboxOrigin = new URL(routeUrl).origin;
    const modifiedHtml = injectWrapperScript(html, {
      sandboxOrigin,
      gatewayToken: meta.gatewayToken,
    });

    return withSetCookie(
      new Response(modifiedHtml, {
        status: upstream.status,
        headers: buildTokenHtmlHeaders(meta.gatewayToken, {
          sandboxOrigin,
          proxyOrigin: new URL(request.url).origin,
          upstreamHeaders: upstream.headers,
        }),
      }),
      auth.setCookieHeader,
    );
  }

  return withSetCookie(
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
    auth.setCookieHeader,
  );
}

export async function GET(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function POST(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function PUT(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function PATCH(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function DELETE(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function HEAD(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}

export async function OPTIONS(request: Request, { params }: { params: Params }) {
  const resolved = await params;
  return handleProxy(request, buildTargetPath(resolved.path));
}
