import { AssetSummary } from "@/types/service";

export async function uploadBoardImage(boardId: string, file: File): Promise<AssetSummary> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("Поддерживаются изображения PNG, JPEG, WebP и GIF");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("Размер изображения не должен превышать 10 МБ");
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets`, { method: "POST", body });
  const result: { asset?: AssetSummary; error?: { message?: string } } = await response.json();
  if (!response.ok || !result.asset) throw new Error(result.error?.message || "Не удалось загрузить изображение");
  return result.asset;
}
