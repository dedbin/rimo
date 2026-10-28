"use client";

import { useRef, useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

interface BoardArchiveActionsProps {
  boardId?: string;
  revision?: number;
  disabled?: boolean;
  onImported?: (boardId: string) => void;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "Не удалось обработать архив.";
  } catch { return "Не удалось обработать архив."; }
}

export function BoardArchiveActions({ boardId, revision = 0, disabled, onImported }: BoardArchiveActionsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const router = useRouter();

  const download = async (): Promise<void> => {
    if (!boardId) return;
    setBusy("export");
    try {
      const response = await fetch(`/api/boards/${boardId}/archive?minRevision=${revision}`);
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `rimo-${boardId}.rimo`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("Архив доски скачан.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось скачать архив.");
    } finally { setBusy(null); }
  };

  const restore = async (file?: File): Promise<void> => {
    if (!file) return;
    if (file.size > 256 * 1024 * 1024) { toast.error("Архив должен быть не больше 256 МиБ."); return; }
    setBusy("import");
    try {
      const response = await fetch("/api/boards/import", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { board: { id: string } };
      toast.success("Архив восстановлен в новую доску.");
      if (onImported) onImported(body.board.id);
      else router.push(`/board/${body.board.id}`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось восстановить архив.");
    } finally { setBusy(null); }
  };

  return <div className="flex items-center gap-1">
    <input ref={fileInput} type="file" accept=".rimo,.zip,application/zip" className="hidden" aria-label="Архив Rimo"
      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void restore(file); }} />
    {boardId && <Button variant="ghost" size="sm" disabled={disabled || !!busy} onClick={() => { void download(); }} title="Скачать архив доски с изображениями">
      {busy === "export" ? <Loader2 className="animate-spin" /> : <Download />} Архив
    </Button>}
    <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => fileInput.current?.click()} title="Восстановить архив в новую доску">
      {busy === "import" ? <Loader2 className="animate-spin" /> : <Upload />} Открыть архив
    </Button>
  </div>;
}
