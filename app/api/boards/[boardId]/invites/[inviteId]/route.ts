import { assertSameOrigin, handleApi } from "@/server/http";
import { revokeInvite } from "@/server/invites";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ boardId: string; inviteId: string }> },
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId, inviteId } = await context.params;
    await revokeInvite(boardId, session.user.id, inviteId);
    return new Response(null, { status: 204 });
  });
}
