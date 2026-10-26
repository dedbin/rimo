import { Layer, LayerType } from "@/types/board-canvas";
import type { BoardDocument } from "@/lib/collaboration/document";
import { boardImageAssetId, copyBoardImageAssets } from "./assets-client";
import type { BoardClipboard } from "./clipboard";

async function transferImages(boardId: string, layers: readonly Layer[], signal?: AbortSignal): Promise<Layer[]> {
  const ids = layers.filter((layer) => layer.type === LayerType.Image).map((layer) => {
    const id = boardImageAssetId(layer.src);
    if (!id) throw new Error("В буфере есть неподдерживаемое изображение. Вставка отменена.");
    return id;
  });
  const assets = await copyBoardImageAssets(boardId, ids, signal);
  return layers.map((layer) => layer.type === LayerType.Image
    ? { ...layer, src: assets.get(boardImageAssetId(layer.src)!)!.url } : layer);
}

/** All assets must cross the destination ACL boundary before the single board transaction. */
export async function insertBoardClipboard(
  boardId: string, board: Pick<BoardDocument, "canEdit" | "insert">,
  clipboard: BoardClipboard, signal?: AbortSignal,
): Promise<string[]> {
  if (!board.canEdit || signal?.aborted || !clipboard.layers.length) return [];
  const layers = await transferImages(boardId, clipboard.layers, signal);
  if (signal?.aborted) return [];
  if (!board.canEdit) throw new Error("Право редактирования изменилось. Вставка отменена.");
  return board.insert(layers, clipboard.richText);
}
