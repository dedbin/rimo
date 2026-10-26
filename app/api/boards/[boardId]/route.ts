import { deleteBoard, getBoardSummary, parseBoardTitle, renameBoard } from "@/server/boards";
import { assertSameOrigin, handleApi, jsonResponse, readJsonObject } from "@/server/http";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ boardId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const { boardId } = await context.params;
    return jsonResponse({ board: await getBoardSummary(boardId, session.user.id) });
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    const body = await readJsonObject(request);
    return jsonResponse({ board: await renameBoard(boardId, session.user.id, parseBoardTitle(body.title)) });
  });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    await deleteBoard(boardId, session.user.id);
    return new Response(null, { status: 204 });
  });
}
