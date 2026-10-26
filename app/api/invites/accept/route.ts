import { assertSameOrigin, handleApi, jsonResponse, readJsonObject } from "@/server/http";
import { acceptInvite } from "@/server/invites";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const body = await readJsonObject(request);
    const board = await acceptInvite(session.user.id, body.token, body.name, !!session.user.isAnonymous);
    return jsonResponse({ board });
  });
}
