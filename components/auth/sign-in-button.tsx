"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

export function SignInButton({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const result = await authClient.signIn.email({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      if (result.error) {
        setError("Не удалось войти. Проверьте почту и пароль.");
      } else {
        setOpen(false);
      }
    } catch {
      setError("Сервис временно недоступен. Попробуйте ещё раз.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Вход в Rimo</DialogTitle>
          <DialogDescription>
            Войдите в аккаунт владельца. Ученики открывают доску по приглашению.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block space-y-2 text-sm">
            <span>Почта</span>
            <Input name="email" type="email" autoComplete="username" required maxLength={254} disabled={pending} />
          </label>
          <label className="block space-y-2 text-sm">
            <span>Пароль</span>
            <Input name="password" type="password" autoComplete="current-password" required disabled={pending} />
          </label>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Входим…" : "Войти"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
