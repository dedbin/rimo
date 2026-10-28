import { assertSameOrigin, jsonResponse } from "@/server/http";
import { handlePdfApi, preparePdfPreview } from "@/server/exports/service";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ boardId: string }> }): Promise<Response> {
  return handlePdfApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    return jsonResponse(await preparePdfPreview(boardId, session.user.id, request), 201);
  });
}
