import { type NextRequest, NextResponse } from "next/server";
import {
  isPrivatePath,
  newNonce,
  PRIVATE_HEADERS,
  securityHeaders,
} from "@/lib/security-headers";

// Runs on every request: there is no matcher, so no response goes without the
// headers. The policy is also put on the request, which is where Next.js reads
// the nonce it adds to its own script and style tags.
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const headers = securityHeaders(
    nonce,
    process.env.NODE_ENV === "development",
  );

  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set(
    "Content-Security-Policy",
    headers["Content-Security-Policy"],
  );

  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  if (isPrivatePath(request.nextUrl.pathname)) {
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
      response.headers.set(name, value);
    }
  }
  return response;
}
