"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { BoardSession } from "@/types/service";
import { BoardRuntime } from "@/lib/collaboration/runtime";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import { EmailVerificationGate } from "@/components/auth/email-verification-gate";

interface RoomProps {
  children: ReactNode;
  roomId: string;
  fallback: ReactNode;
}

export function Room({ children, roomId, fallback }: RoomProps) {
  return (
    <EmailVerificationGate fallback={fallback}>
      <RoomContent roomId={roomId} fallback={fallback}>{children}</RoomContent>
    </EmailVerificationGate>
  );
}

function RoomContent({ children, roomId, fallback }: RoomProps) {
  const [runtime, setRuntime] = useState<BoardRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let current: BoardRuntime | null = null;
    let active = true;
    setRuntime(null);
    setError(null);
    void fetch(`/api/boards/${encodeURIComponent(roomId)}/session`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401
          ? "Для открытия доски войдите или используйте приглашение."
          : "Доска недоступна. Проверьте приглашение или обратитесь к владельцу.");
        return response.json() as Promise<BoardSession>;
      })
      .then((session) => {
        if (!active) return;
        current = new BoardRuntime(session);
        setRuntime(current);
      })
      .catch((reason: unknown) => {
        if (active && !(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "Не удалось открыть доску");
        }
      });
    return () => {
      active = false;
      controller.abort();
      current?.destroy();
    };
  }, [roomId]);

  useEffect(() => {
    if (!runtime) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (runtime.getState().pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [runtime]);

  if (error) return <div role="alert" className="flex h-screen items-center justify-center p-8 text-center">{error} <Link className="ml-2 underline" href="/">На главную</Link></div>;
  if (!runtime) return fallback;
  return <BoardRuntimeContext.Provider value={runtime}>{children}</BoardRuntimeContext.Provider>;
}
