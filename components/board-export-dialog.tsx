"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileDown, Loader2, Trash2 } from "lucide-react";

import { BoardExportPreview } from "@/components/board-export-preview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { MAX_PDF_PAGES } from "@/export-worker/contract";
import type { PdfFormat, PdfOrientation, PdfPreview, PdfRequest } from "@/export-worker/contract";
import { boundsForLayers, MAX_FRAMES, parseFrame } from "@/lib/board/frames";
import type { BoardFrame } from "@/lib/board/frames";
import type { Layer, XYWH } from "@/types/board-canvas";

export interface BoardExportDialogProps {
  boardId: string;
  revision: number;
  saved: boolean;
  canEdit: boolean;
  selection: readonly string[];
  snapshot: { readonly layers: ReadonlyMap<string, Layer>; readonly frames: ReadonlyMap<string, BoardFrame>; readonly frameIds: readonly string[] };
  onCreateFrame: (frame: BoardFrame) => void;
  onRenameFrame: (id: string, name: string) => void;
  onRemoveFrame: (id: string) => void;
  onFrameOrderChange: (ids: readonly string[]) => void;
}

async function responseError(response: Response): Promise<string> {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message ?? "Не удалось подготовить PDF."; }
  catch { return "Не удалось подготовить PDF."; }
}

export function BoardExportDialog({ boardId, revision, saved, canEdit, selection, snapshot, onCreateFrame, onRenameFrame, onRemoveFrame, onFrameOrderChange }: BoardExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"selection" | "frames">("selection");
  const [frameIds, setFrameIds] = useState<readonly string[]>([]);
  const [format, setFormat] = useState<PdfFormat>("A4");
  const [orientation, setOrientation] = useState<PdfOrientation>("portrait");
  const [preview, setPreview] = useState<PdfPreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameName, setFrameName] = useState("Урок");
  const [region, setRegion] = useState<XYWH>({ x: 0, y: 0, width: 800, height: 600 });
  const [showRegion, setShowRegion] = useState(false);
  const token = useRef<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  const discard = useCallback((): void => {
    if (token.current) void fetch(`/api/boards/${boardId}/pdf/preview/${token.current}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    token.current = null;
  }, [boardId]);
  const invalidate = (): void => { discard(); setPreview(null); setAccepted(false); setError(null); };
  useEffect(() => () => { pending.current?.abort(); discard(); }, [discard]);

  const toggleOpen = (next: boolean): void => {
    if (!next) { pending.current?.abort(); invalidate(); setBusy(null); }
    else {
      setMode(selection.length ? "selection" : "frames");
      const bounds = boundsForLayers(selection.flatMap((id) => snapshot.layers.get(id) ? [snapshot.layers.get(id)!] : []));
      if (bounds) setRegion(bounds);
    }
    setOpen(next);
  };
  const selectedFrames = frameIds.filter((id) => snapshot.frames.has(id));
  const orderedFrames = [...selectedFrames, ...snapshot.frameIds.filter((id) => !selectedFrames.includes(id))];
  const canPreview = saved && !busy && (mode === "selection" ? selection.length > 0 : selectedFrames.length > 0);

  const move = (id: string, direction: -1 | 1): void => {
    const current = [...selectedFrames];
    const index = current.indexOf(id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= current.length) return;
    [current[index], current[destination]] = [current[destination], current[index]];
    setFrameIds(current);
    if (canEdit) onFrameOrderChange([...current, ...snapshot.frameIds.filter((frameId) => !current.includes(frameId))]);
    invalidate();
  };

  const prepare = async (): Promise<void> => {
    if (!canPreview) return;
    invalidate();
    setBusy("preview");
    const controller = new AbortController();
    pending.current = controller;
    const body: PdfRequest = { minimumRevision: revision, pages: mode === "selection"
      ? [{ format, orientation, source: { type: "selection", layerIds: [...selection] } }]
      : selectedFrames.map((frameId) => ({ format, orientation, source: { type: "frame", frameId } })) };
    try {
      const response = await fetch(`/api/boards/${boardId}/pdf/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as PdfPreview;
      controller.signal.throwIfAborted();
      token.current = result.token;
      setPreview(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось подготовить PDF.");
    } finally { if (pending.current === controller) { pending.current = null; setBusy(null); } }
  };

  const download = async (): Promise<void> => {
    if (!preview || busy || (preview.warnings.length && !accepted)) return;
    setBusy("download");
    setError(null);
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await fetch(`/api/boards/${boardId}/pdf`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token, acceptWarnings: accepted }), signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `rimo-${boardId}-r${preview.revision}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось скачать PDF.");
    } finally { if (pending.current === controller) { pending.current = null; setBusy(null); } }
  };

  return <Dialog open={open} onOpenChange={toggleOpen}>
    <DialogTrigger asChild><Button variant="ghost" size="sm" title="PDF по выделению или фреймам"><FileDown /> PDF</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto sm:max-w-5xl">
      <DialogHeader><DialogTitle>Экспорт в PDF</DialogTitle><DialogDescription>Выделение или именованные области доски. До 20 страниц; предпросмотр фиксирует сохранённую версию.</DialogDescription></DialogHeader>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="pdf-source" checked={mode === "selection"} disabled={!!busy}
              onChange={() => { setMode("selection"); invalidate(); }} />Выделение ({selection.length})</label>
            <label className="flex items-center gap-2"><input type="radio" name="pdf-source" checked={mode === "frames"} disabled={!!busy}
              onChange={() => { setMode("frames"); invalidate(); }} />Фреймы</label>
          </div>
          {mode === "frames" && <div className="max-h-64 space-y-2 overflow-y-auto rounded border p-2">
            {orderedFrames.length === 0 && <p className="text-sm text-muted-foreground">Добавьте именованную область ниже.</p>}
            {orderedFrames.map((id) => {
              const frame = snapshot.frames.get(id);
              if (!frame) return null;
              const index = selectedFrames.indexOf(id);
              return <div key={id} className="flex items-center gap-1">
                <input type="checkbox" aria-label={`Экспортировать фрейм ${frame.name}`} checked={index >= 0} disabled={!!busy || (index < 0 && selectedFrames.length >= MAX_PDF_PAGES)}
                  onChange={() => { setFrameIds(index < 0 ? [...selectedFrames, id] : selectedFrames.filter((value) => value !== id)); invalidate(); }} />
                {index >= 0 && <span className="w-5 text-xs text-muted-foreground">{index + 1}.</span>}
                <input key={`${id}-${frame.name}`} aria-label="Название фрейма" defaultValue={frame.name} maxLength={120} disabled={!canEdit || !!busy}
                  className="min-w-0 flex-1 rounded border px-2 py-1 text-sm disabled:border-transparent"
                  onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== frame.name) { onRenameFrame(id, name); invalidate(); } }} />
                {index >= 0 && <><Button size="icon" variant="ghost" title="Выше" disabled={!!busy || index === 0} onClick={() => move(id, -1)}><ArrowUp className="size-4" /></Button>
                  <Button size="icon" variant="ghost" title="Ниже" disabled={!!busy || index === selectedFrames.length - 1} onClick={() => move(id, 1)}><ArrowDown className="size-4" /></Button></>}
                {canEdit && <Button size="icon" variant="ghost" title="Удалить фрейм" disabled={!!busy} onClick={() => { onRemoveFrame(id); invalidate(); }}><Trash2 className="size-4" /></Button>}
              </div>;
            })}
          </div>}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="space-y-1">Формат<select aria-label="Формат страниц" value={format} disabled={!!busy} className="block w-full rounded border p-2"
              onChange={(event) => { setFormat(event.target.value as PdfFormat); invalidate(); }}>{["A4", "A3", "Letter"].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label className="space-y-1">Ориентация<select aria-label="Ориентация страниц" value={orientation} disabled={!!busy} className="block w-full rounded border p-2"
              onChange={(event) => { setOrientation(event.target.value as PdfOrientation); invalidate(); }}><option value="portrait">Книжная</option><option value="landscape">Альбомная</option></select></label>
          </div>
          {canEdit && <div className="space-y-2 rounded border p-3">
            <button className="text-sm underline" onClick={() => setShowRegion(!showRegion)}>{showRegion ? "Скрыть область фрейма" : "Добавить фрейм по выделению или координатам"}</button>
            {showRegion && <>
              <input aria-label="Имя нового фрейма" value={frameName} maxLength={120} className="w-full rounded border p-2 text-sm" onChange={(event) => setFrameName(event.target.value)} />
              <div className="grid grid-cols-2 gap-2">{(["x", "y", "width", "height"] as const).map((key) => <label key={key} className="text-xs">{{ x: "X", y: "Y", width: "Ширина", height: "Высота" }[key]}
                <input type="number" aria-label={`Фрейм: ${{ x: "X", y: "Y", width: "Ширина", height: "Высота" }[key]}`} value={region[key]} className="block w-full rounded border p-1 text-sm"
                  onChange={(event) => setRegion({ ...region, [key]: Number(event.target.value) })} /></label>)}</div>
              <Button size="sm" variant="outline" disabled={!!busy || snapshot.frames.size >= MAX_FRAMES || !parseFrame({ ...region, name: frameName })}
                onClick={() => { const frame = parseFrame({ ...region, name: frameName }); if (frame) { onCreateFrame(frame); setMode("frames"); invalidate(); } }}>Добавить фрейм</Button>
            </>}
          </div>}
          {!saved && <p className="text-sm text-amber-700" role="status">Дождитесь подтверждения сохранения доски, чтобы создать предпросмотр.</p>}
          <Button variant="outline" disabled={!canPreview} onClick={() => { void prepare(); }}>{busy === "preview" && <Loader2 className="animate-spin" />}Создать предпросмотр</Button>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
        <div className="space-y-3">
          {preview ? <>
            <p className="text-sm">Зафиксирована версия {preview.revision}. Новые правки доски не изменят этот PDF.</p>
            <BoardExportPreview boardId={boardId} preview={preview} />
            {preview.warnings.length > 0 && <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              {preview.warnings.map((warning) => <p key={`${warning.page}-${warning.code}`}>{warning.message}</p>)}
              <label className="flex items-start gap-2"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />Я проверил масштаб и границы всех страниц</label>
            </div>}
            <Button disabled={!!busy || (preview.warnings.length > 0 && !accepted)} onClick={() => { void download(); }}>{busy === "download" ? <Loader2 className="animate-spin" /> : <FileDown />}Скачать PDF</Button>
            <p className="text-xs text-muted-foreground">Предпросмотр доступен 5 минут. Изображения сохраняют исходное разрешение.</p>
          </> : <div className="flex min-h-64 items-center justify-center rounded border border-dashed p-6 text-center text-sm text-muted-foreground">После выбора страниц здесь появится предпросмотр сохранённой версии.</div>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
