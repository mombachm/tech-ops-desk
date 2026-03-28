import { serve } from "bun";
import index from "./index.html";
import {
  buildRequestUrl,
  prettyJson,
  type ExecutionPayload,
  type ExecutionResult,
  type HttpRequestDefinition,
} from "./contracts";

const port = Number(process.env.PORT ?? 3000);

const server = serve({
  port,
  routes: {
    "/*": index,
    "/api/execute": {
      async POST(request) {
        let payload: ExecutionPayload;
        try {
          payload = (await request.json()) as ExecutionPayload;
        } catch {
          return new Response("Invalid JSON payload", { status: 400 });
        }

        if (!payload.request || typeof payload.request.method !== "string" || typeof payload.request.url !== "string") {
          return new Response("request.method and request.url are required", { status: 400 });
        }

        try {
          const result = await executeStructuredRequest(payload.request);
          return Response.json(result);
        } catch (error) {
          return new Response(String(error), { status: 500 });
        }
      },
    },
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Tech Ops Desk running at ${server.url}`);

async function executeStructuredRequest(request: HttpRequestDefinition): Promise<ExecutionResult> {
  const finalUrl = buildRequestUrl(request);
  const headers = new Headers(request.headers ?? {});
  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
  };

  if (!["GET", "HEAD"].includes(method) && request.body !== undefined) {
    if (typeof request.body === "string") {
      init.body = request.body;
    } else {
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      init.body = JSON.stringify(request.body);
    }
  }

  const response = await fetch(finalUrl, init);
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    finalUrl,
    responseHeaders,
    responsePreview: createResponsePreview(bodyText, contentType),
  };
}

function createResponsePreview(body: string, contentType: string): string {
  if (!body) return "";

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return truncate(prettyJson(parsed));
    } catch {
      return truncate(body);
    }
  }

  return truncate(body);
}

function truncate(value: string): string {
  return value.length > 400 ? `${value.slice(0, 397)}...` : value;
}
