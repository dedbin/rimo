"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { requestJson } from "@/lib/api-client";
import type { BoardSummary } from "@/types/service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserButton } from "@/components/auth/user-button";

export default function InvitePage() {
  const { data: session, isPending } = authClient.useSession();
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const capturedToken = useRef(false);

  useEffect(() => {
    if (capturedToken.current) return;
    capturedToken.current = true;
    setToken(window.location.hash.slice(1));
    window.history.replaceState(null, "", "/invite");
  }, []);

  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    setPending(true);
    setError("");
    try {
      if (!session) {
        const result = await authClient.signIn.anonymous();
        if (result.error) throw new Error("Guest sign in failed");
      }
      const { board } = await requestJson<{ board: BoardSummary }>("/api/invites/accept", {
        method: "POST", body: JSON.stringify({ token, name }),
      });
      router.replace(`/board/${board.id}`);
    } catch {
      setError("Не удалось открыть доску. Ссылка могла истечь или быть отозвана. Попросите владельца проверить приглашение.");
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-100 p-6">
      <div className="w-full max-w-md space-y-5 rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Приглашение в Rimo</h1>
          <UserButton />
        </div>
        {token === "" ? <p role="alert">В ссылке нет приглашения. Откройте полную ссылку, которую прислал владелец доски.</p> : (
          <form onSubmit={accept} className="space-y-4">
            <p className="text-sm text-muted-foreground">Чтобы присоединиться к доске, регистрация не нужна.</p>
            <label className="block space-y-2 text-sm">
              <span>Как вас представить</span>
              <Input name="name" defaultValue={session?.user.name ?? ""} required maxLength={60}
                autoComplete="name" disabled={pending || isPending} />
            </label>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={pending || isPending || token === null}>
              {pending ? "Открываем…" : "Войти на доску"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
