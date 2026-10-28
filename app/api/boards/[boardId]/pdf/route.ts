import { assertSameOrigin, readJsonObject } from "@/server/http";
import { HttpError } from "@/server/http-error";
import { downloadPdf, handlePdfApi } from "@/server/exports/service";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ boardId: string }> }): Promise<Response> {
  return handlePdfApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    const body = await readJsonObject(request);
    if (typeof body.token !== "string" || !/^[a-zA-Z0-9_-]{32}$/.test(body.token) || typeof body.acceptWarnings !== "boolean") {
      throw new HttpError(400, "INVALID_PDF_TOKEN", "Некорректный снимок PDF.");
    }
    return downloadPdf(boardId, session.user.id, body.token, body.acceptWarnings, request.signal);
  });
}
