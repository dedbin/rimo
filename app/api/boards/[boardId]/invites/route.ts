import { getServerConfig } from "@/server/config";
import { assertSameOrigin, handleApi, jsonResponse, readJsonObject } from "@/server/http";
import { createInvite, listInvites } from "@/server/invites";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ boardId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const { boardId } = await context.params;
    return jsonResponse({ invites: await listInvites(boardId, session.user.id) });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    const body = await readJsonObject(request);
    const created = await createInvite(boardId, session.user.id, body.role, body.expiresInHours);
    const url = new URL("/invite", getServerConfig().authUrl);
    url.hash = created.token;
    return jsonResponse({ ...created, url: url.toString() }, 201);
  });
}
