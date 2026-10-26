import { downloadAsset } from "@/server/assets";
import { handleApi } from "@/server/http";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  return handleApi(async () => {
    const session = await requireSession(request);
    const { assetId } = await context.params;
    return downloadAsset(assetId, session.user.id);
  });
}
