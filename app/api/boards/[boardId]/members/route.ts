import { handleApi, jsonResponse } from "@/server/http";
import { listMembers } from "@/server/members";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ boardId: string }> },
): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const { boardId } = await context.params;
    return jsonResponse({ members: await listMembers(boardId, session.user.id) });
  });
}
