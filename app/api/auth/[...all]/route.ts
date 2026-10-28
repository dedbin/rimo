import { toNextJsHandler } from "better-auth/next-js";

import { getAuth, registerOwnerAccount } from "@/server/auth";
import { assertSameOrigin, handleApi, readRequestBuffer } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    const bytes = await readRequestBuffer(request, 16_384);
    const bounded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(bytes),
      signal: request.signal,
    });
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/api/auth/sign-up/email") {
      assertSameOrigin(bounded);
      return registerOwnerAccount(bounded);
    }
    return toNextJsHandler(getAuth()).POST(bounded);
  });
}
