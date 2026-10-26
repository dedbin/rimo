import { requireBoardAccess } from "@/server/access";
import { uploadAsset, withAssetUpload } from "@/server/assets";
import { getServerConfig } from "@/server/config";
import { assertSameOrigin, handleApi, jsonResponse, readRequestBuffer } from "@/server/http";
import { HttpError } from "@/server/http-error";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ boardId: string }> },
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const session = await requireSession(request);
    const { boardId } = await context.params;
    await requireBoardAccess(boardId, session.user.id, "edit");
    return withAssetUpload(async () => {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
        throw new HttpError(400, "INVALID_UPLOAD", "Нужен файл в формате multipart/form-data.");
      }
      const bytes = await readRequestBuffer(request, getServerConfig().maxUploadBytes + 65_536);
      let form: FormData;
      try {
        form = await new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } }).formData();
      } catch {
        throw new HttpError(400, "INVALID_UPLOAD", "Некорректная форма загрузки.");
      }
      const file = form.get("file");
      if (!(file instanceof File) || form.getAll("file").length !== 1) {
        throw new HttpError(400, "FILE_REQUIRED", "Выберите одно изображение.");
      }
      const asset = await uploadAsset(boardId, session.user.id, Buffer.from(await file.arrayBuffer()));
      return jsonResponse({ asset }, 201);
    });
  });
}
