"use client";

import { useBoardRole, useBoardRuntime, useConnectionState } from "@/lib/collaboration/react";

export function SaveStatus() {
  const runtime = useBoardRuntime();
  const role = useBoardRole();
  const state = useConnectionState();
  const label = state.error ?? (!state.connected ? state.pending ? "Нет соединения — изменения ожидают отправки" : "Нет соединения"
    : !state.synced ? "Подключение к доске…" : state.saved ? "Сохранено" : "Сохранение…");
  return <div className="absolute bottom-2 left-2 z-10 rounded-md bg-white px-3 py-2 text-xs shadow-sm"
    role={state.error ? "alert" : "status"} aria-live="polite" data-save-state={state.saved ? "saved" : "pending"}>
    {role === "viewer" && <span className="mr-2 text-neutral-500">Только просмотр</span>}
    <span className={state.error ? "text-red-600" : !state.connected ? "text-amber-700" : "text-neutral-600"}>{label}</span>
    {state.writeRejection && <div className="mt-1 max-w-sm space-y-1 text-neutral-700">
      <p>Черновик остаётся в этой вкладке. Сохранённую версию можно открыть отдельно и экспортировать.</p>
      <a className="inline-block text-blue-700 underline" href={`/board/${encodeURIComponent(runtime.session.board.id)}`}
        target="_blank" rel="noopener noreferrer">Открыть сохранённую версию</a>
    </div>}
  </div>;
}
