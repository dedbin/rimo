import { exportBoardArchive } from "@/server/archive/export";
import { handleApi } from "@/server/http";
import { HttpError } from "@/server/http-error";
import { requireOwnerSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ boardId: string }> }): Promise<Response> {
  return handleApi(async () => {
    const session = await requireOwnerSession(request);
    const { boardId } = await context.params;
    const minimum = Number(new URL(request.url).searchParams.get("minRevision") ?? 0);
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new HttpError(400, "INVALID_REVISION", "Некорректная версия доски.");
    return exportBoardArchive(boardId, session.user.id, request.signal, minimum);
  });
}
