import { setFavorite } from "@/server/boards";
import { assertSameOrigin, handleApi } from "@/server/http";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
type Context = { params: Promise<{ boardId: string }> };

async function update(request: Request, context: Context, favorite: boolean): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    await setFavorite(boardId, session.user.id, favorite);
    return new Response(null, { status: 204 });
  });
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  return update(request, context, true);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return update(request, context, false);
}
