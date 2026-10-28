import { copyBoardAssets } from "@/server/asset-copy";
import { withAssetUpload } from "@/server/assets";
import { assertSameOrigin, handleApi, jsonResponse, readJsonObject } from "@/server/http";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";

export async function POST(
  request: Request, context: { params: Promise<{ boardId: string }> },
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    const body = await readJsonObject(request);
    const assets = await withAssetUpload(() => copyBoardAssets(boardId, session.user.id, body.assetIds));
    return jsonResponse({ assets }, 201);
  });
}
