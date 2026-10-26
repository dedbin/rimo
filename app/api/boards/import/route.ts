import { importBoardArchive } from "@/server/archive/import";
import { assertSameOrigin, handleApi, jsonResponse } from "@/server/http";
import { requireOwnerSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireOwnerSession(request);
    return jsonResponse({ board: await importBoardArchive(request, session.user.id) }, 201);
  });
}
