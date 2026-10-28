import { containsBounds, visualBounds } from "../../lib/board/frames";
import { LayerType } from "../../types/board-canvas";
import { pageMetrics } from "../../export-worker/contract";
import type { PdfJob, PdfWarning } from "../../export-worker/contract";

export function pdfWarnings(job: PdfJob): PdfWarning[] {
  const layers = new Map(job.layers.map((item) => [item.id, item.layer]));
  return job.pages.flatMap((page, index) => {
    const scale = pageMetrics(page).scale;
    const selected = page.layerIds.map((id) => layers.get(id)!);
    const warnings: PdfWarning[] = [];
    if (selected.some((layer) => (layer.type === LayerType.Text || layer.type === LayerType.Sticker) && layer.fontSize * scale * 72 / 96 < 9)) {
      warnings.push({ page: index, code: "SMALL_TEXT", message: `Страница ${index + 1}: текст получится мельче 9 pt. Разбейте область на несколько фреймов или выберите больший лист.` });
    }
    if (selected.some((layer) => !containsBounds(page.bounds, visualBounds(layer)))) {
      warnings.push({ page: index, code: "CLIPPED_OBJECT", message: `Страница ${index + 1}: граница фрейма обрезает часть объекта. Расширьте фрейм или проверьте, что обрезка нужна.` });
    }
    return warnings;
  });
}
