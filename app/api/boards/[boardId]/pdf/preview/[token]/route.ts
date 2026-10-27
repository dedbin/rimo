import { assertSameOrigin } from "@/server/http";
import { discardPdfPreview, handlePdfApi, previewPdfPage } from "@/server/exports/service";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ boardId: string; token: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handlePdfApi(async () => {
    const session = await requireSession(request);
    const { boardId, token } = await context.params;
    return previewPdfPage(boardId, session.user.id, token, Number(new URL(request.url).searchParams.get("page") ?? 0), request.signal);
  });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handlePdfApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId, token } = await context.params;
    await discardPdfPreview(boardId, session.user.id, token);
    return new Response(null, { status: 204 });
  });
}
