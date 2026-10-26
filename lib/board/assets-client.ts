import { AssetSummary } from "@/types/service";

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COPY_ASSETS = 100;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown, fallback: string): string {
  return record(value) && record(value.error) && typeof value.error.message === "string" ? value.error.message : fallback;
}

function parseAsset(value: unknown): AssetSummary | null {
  if (!record(value) || typeof value.id !== "string" || !ASSET_ID.test(value.id) ||
    value.url !== `/api/assets/${value.id}` || value.mimeType !== "image/webp" ||
    ![value.width, value.height, value.size].every((number) => typeof number === "number" && Number.isSafeInteger(number) && number > 0)) return null;
  return value as unknown as AssetSummary;
}

export function boardImageAssetId(source: string): string | null {
  const match = /^\/api\/assets\/([^/]+)$/.exec(source);
  return match && ASSET_ID.test(match[1]) ? match[1].toLowerCase() : null;
}

export async function copyBoardImageAssets(
  boardId: string, assetIds: readonly string[], signal?: AbortSignal,
): Promise<ReadonlyMap<string, AssetSummary>> {
  const ids = [...new Set(assetIds.map((id) => id.toLowerCase()))];
  if (!ids.length) return new Map();
  if (ids.length > MAX_COPY_ASSETS || ids.some((id) => !ASSET_ID.test(id))) {
    throw new Error(`За одну вставку можно перенести до ${MAX_COPY_ASSETS} изображений доски.`);
  }
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets/copy`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetIds: ids }), signal,
  });
  const result: unknown = await response.json();
  const fallback = "Не удалось перенести изображения. Вставка отменена.";
  if (!response.ok) throw new Error(errorMessage(result, fallback));
  if (!record(result) || !record(result.assets) || Object.keys(result.assets).length !== ids.length) throw new Error(fallback);
  const assets = new Map<string, AssetSummary>();
  for (const id of ids) {
    const asset = Object.hasOwn(result.assets, id) ? parseAsset(result.assets[id]) : null;
    if (!asset) throw new Error(fallback);
    assets.set(id, asset);
  }
  return assets;
}

export function validateBoardImageFile(file: File): void {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("Поддерживаются изображения PNG, JPEG, WebP и GIF");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("Размер изображения не должен превышать 10 МБ");
}

export async function uploadBoardImage(boardId: string, file: File, signal?: AbortSignal): Promise<AssetSummary> {
  validateBoardImageFile(file);
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets`, { method: "POST", body, signal });
  const result: unknown = await response.json();
  const asset = record(result) ? parseAsset(result.asset) : null;
  if (!response.ok || !asset) throw new Error(errorMessage(result, "Не удалось загрузить изображение"));
  return asset;
}
