import { createBoard, listBoards, parseBoardTitle } from "@/server/boards";
import { assertSameOrigin, handleApi, jsonResponse, readJsonObject } from "@/server/http";
import { requireOwnerSession, requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const url = new URL(request.url);
    const boards = await listBoards(session.user.id, {
      search: url.searchParams.get("search") ?? undefined,
      favorites: url.searchParams.get("favorites") === "1",
    });
    return jsonResponse({ boards });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireOwnerSession(request);
    const body = await readJsonObject(request);
    const board = await createBoard(session.user.id, parseBoardTitle(body.title));
    return jsonResponse({ board }, 201);
  });
}
