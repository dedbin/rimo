"use client";

import { useState } from "react";
import useSWR from "swr";
import { Copy, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { requestJson } from "@/lib/api-client";
import type { BoardInvite } from "@/types/service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

interface Member {
  userId: string;
  name: string;
  role: "editor" | "viewer";
  expiresAt: string;
  revokedAt: string | null;
}

export function BoardShareButton({ boardId }: { boardId: string }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const base = `/api/boards/${encodeURIComponent(boardId)}`;
  const invites = useSWR(open ? `${base}/invites` : null,
    requestJson<{ invites: BoardInvite[] }>);
  const members = useSWR(open ? `${base}/members` : null,
    requestJson<{ members: Member[] }>);

  const create = async () => {
    setPending(true);
    try {
      const result = await requestJson<{ url: string }>(`${base}/invites`, {
        method: "POST", body: JSON.stringify({ role, expiresInHours: 24 * 7 }),
      });
      setUrl(result.url);
      await invites.mutate();
    } catch {
      toast.error("Не удалось создать приглашение");
    } finally {
      setPending(false);
    }
  };

  const revoke = async (path: string) => {
    setPending(true);
    try {
      await requestJson(path, { method: "DELETE" });
      setUrl("");
      await Promise.all([invites.mutate(), members.mutate()]);
    } catch {
      toast.error("Не удалось отозвать доступ");
    } finally {
      setPending(false);
    }
  };

  const changeRole = async (userId: string, nextRole: "editor" | "viewer") => {
    setPending(true);
    try {
      await requestJson(`${base}/members/${encodeURIComponent(userId)}`, {
        method: "PATCH", body: JSON.stringify({ role: nextRole }),
      });
      await members.mutate();
    } catch {
      toast.error("Не удалось изменить права");
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Приглашение скопировано");
    } catch {
      toast.error("Выделите ссылку и скопируйте её вручную");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setUrl(""); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Link2 className="mr-2 h-4 w-4" />Поделиться</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Доступ к доске</DialogTitle>
          <DialogDescription>Гость входит по ссылке без регистрации. Приглашение действует семь дней.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="invite-role">Права по приглашению</label>
          <select id="invite-role" value={role} disabled={pending}
            className="h-9 flex-1 rounded-md border bg-white px-2 text-sm"
            onChange={(event) => setRole(event.target.value as "editor" | "viewer")}>
            <option value="editor">Можно редактировать</option>
            <option value="viewer">Только просмотр</option>
          </select>
          <Button disabled={pending} onClick={() => void create()}>Создать ссылку</Button>
        </div>
        {url && <div className="flex gap-2">
          <Input aria-label="Ссылка-приглашение" readOnly value={url} onFocus={(event) => event.target.select()} />
          <Button variant="outline" size="icon" aria-label="Скопировать приглашение" onClick={() => void copy()}><Copy className="h-4 w-4" /></Button>
        </div>}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Приглашения</h2>
          {invites.error && <p role="alert" className="text-sm">Не удалось загрузить приглашения.</p>}
          {invites.data?.invites.filter((invite) => !invite.revokedAt).map((invite) => (
            <div key={invite.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{invite.role === "editor" ? "Редактирование" : "Просмотр"} · до {new Date(invite.expiresAt).toLocaleDateString("ru-RU")}</span>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void revoke(`${base}/invites/${invite.id}`)}>Отозвать</Button>
            </div>
          ))}
          {invites.data?.invites.length === 0 && <p className="text-sm text-muted-foreground">Приглашений пока нет.</p>}
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Участники</h2>
          {members.error && <p role="alert" className="text-sm">Не удалось загрузить участников.</p>}
          {members.data?.members.filter((member) => !member.revokedAt).map((member) => (
            <div key={member.userId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
              <select value={member.role} disabled={pending} className="rounded border p-1"
                aria-label={`Права: ${member.name}`}
                onChange={(event) => void changeRole(member.userId, event.target.value as "editor" | "viewer")}>
                <option value="editor">Редактор</option><option value="viewer">Просмотр</option>
              </select>
              <Button variant="ghost" size="icon" disabled={pending} aria-label={`Отозвать доступ: ${member.name}`}
                onClick={() => void revoke(`${base}/members/${encodeURIComponent(member.userId)}`)}><X className="h-4 w-4" /></Button>
            </div>
          ))}
          {members.data?.members.length === 0 && <p className="text-sm text-muted-foreground">Пока никто не присоединился.</p>}
        </section>
      </DialogContent>
    </Dialog>
  );
}
