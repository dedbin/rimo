import { getBoardSummary } from "@/server/boards";
import { getServerConfig } from "@/server/config";
import { handleApi, jsonResponse } from "@/server/http";
import { requireSession } from "@/server/session";
import type { BoardSession } from "@/types/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ boardId: string }> },
): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const { boardId } = await context.params;
    const board = await getBoardSummary(boardId, session.user.id);
    const result: BoardSession = {
      board,
      role: board.role,
      user: { id: session.user.id, name: session.user.name, image: session.user.image },
      connection: { url: getServerConfig().collaborationUrl, token: "cookie" },
    };
    return jsonResponse(result);
  });
}
