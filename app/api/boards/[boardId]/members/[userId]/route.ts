import { assertSameOrigin, handleApi, readJsonObject } from "@/server/http";
import { revokeMember, updateMember } from "@/server/members";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
type Context = { params: Promise<{ boardId: string; userId: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId, userId } = await context.params;
    const body = await readJsonObject(request);
    await updateMember(boardId, session.user.id, userId, body.role);
    return new Response(null, { status: 204 });
  });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId, userId } = await context.params;
    await revokeMember(boardId, session.user.id, userId);
    return new Response(null, { status: 204 });
  });
}
