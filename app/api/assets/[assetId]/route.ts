import { downloadAsset } from "@/server/assets";
import { handleApi } from "@/server/http";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ assetId: string }> }

async function respond(
  request: Request, context: RouteContext, head: boolean,
): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const { assetId } = await context.params;
    return downloadAsset(assetId, session.user.id, { head, signal: request.signal });
  });
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return respond(request, context, false);
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  return respond(request, context, true);
}
