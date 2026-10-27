"use client";

import { useEffect, useRef, useState } from "react";

import { PDF_FORMATS } from "@/export-worker/contract";
import type { PdfPreview } from "@/export-worker/contract";
import { Button } from "@/components/ui/button";

export function BoardExportPreview({ boardId, preview }: { boardId: string; preview: PdfPreview }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [pageIndex, setPageIndex] = useState(0);
  const current = Math.min(pageIndex, preview.pages.length - 1);
  const page = preview.pages[current];
  const dimensions = PDF_FORMATS[page.format];
  const pageWidth = dimensions[page.orientation === "portrait" ? 0 : 1] * 96 / 25.4;
  const pageHeight = dimensions[page.orientation === "portrait" ? 1 : 0] * 96 / 25.4;
  const scale = Math.min(1, width / pageWidth);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2 text-sm">
      <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPageIndex(current - 1)}>Назад</Button>
      <span>{current + 1} / {preview.pages.length} · {page.name}</span>
      <Button variant="outline" size="sm" disabled={current === preview.pages.length - 1} onClick={() => setPageIndex(current + 1)}>Далее</Button>
    </div>
    <div ref={container} className="overflow-hidden rounded border bg-slate-100" style={{ height: pageHeight * scale }}>
      <iframe key={`${preview.token}-${current}`} title={`Предпросмотр: ${page.name}`} sandbox="" referrerPolicy="no-referrer"
        src={`/api/boards/${boardId}/pdf/preview/${preview.token}?page=${current}`}
        style={{ width: pageWidth, height: pageHeight, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }} />
    </div>
    <p className="text-xs text-muted-foreground">Масштаб на бумаге: {Math.round(page.scale * 100)}%. Текст и фигуры остаются векторными.</p>
  </div>;
}
