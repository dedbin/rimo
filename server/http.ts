import { getServerConfig } from "./config";
import { HttpError } from "./http-error";

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && !getServerConfig().trustedOrigins.includes(origin)) {
    throw new HttpError(403, "INVALID_ORIGIN", "Недопустимый источник запроса.");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "INVALID_ORIGIN", "Недопустимый источник запроса.");
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse((await readRequestBuffer(request, 16_384)).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON", "Некорректный JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "Ожидается объект JSON.");
  }
  return body as Record<string, unknown>;
}

export async function readRequestBuffer(request: Request, maxBytes: number, timeoutMs = 15_000): Promise<Buffer> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new HttpError(413, "BODY_TOO_LARGE", "Запрос слишком большой.");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      reject(new HttpError(408, "BODY_TIMEOUT", "Не удалось получить запрос вовремя."));
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), expired]);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", "Запрос слишком большой.");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    if (deadline) clearTimeout(deadline);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function handleApi(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: { code: error.code, message: error.message } }, {
        status: error.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    console.error("API request failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "Не удалось выполнить запрос." } }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
