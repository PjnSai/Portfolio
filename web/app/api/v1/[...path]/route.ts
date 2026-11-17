import {
  forwardedHeaders,
  MAX_BODY_BYTES,
  returnedHeaders,
  upstreamUrl,
} from "@/lib/api-proxy";

const TIMEOUT_MS = 10_000;

function refusal(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

async function pass(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const base = process.env.API_URL;
  // Fail closed: with no API configured, nothing is passed anywhere.
  if (!base) return refusal(503, "Service unavailable.");
  const { path } = await params;
  const target = upstreamUrl(base, path, new URL(request.url).search);
  if (!target) return refusal(404, "Not found.");

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return refusal(413, "Too large.");
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return refusal(413, "Too large.");
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: forwardedHeaders(request.headers),
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: returnedHeaders(upstream.headers),
    });
  } catch {
    return refusal(503, "Service unavailable.");
  }
}

export const GET = pass;
export const POST = pass;
export const PATCH = pass;
export const PUT = pass;
export const DELETE = pass;
