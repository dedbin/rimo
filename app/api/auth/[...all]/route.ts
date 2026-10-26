import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/server/auth";
import { handleApi, readRequestBuffer } from "@/server/http";

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
    return toNextJsHandler(getAuth()).POST(bounded);
  });
}
