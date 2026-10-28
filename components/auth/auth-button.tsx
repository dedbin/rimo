"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

type AuthMode = "sign-in" | "sign-up";

function failureMessage(error: { code?: string; status?: number }, signUp: boolean): string {
  if (error.status === 429) return "Слишком много попыток. Попробуйте через минуту.";
  if (error.code === "OWNER_LIMIT_REACHED") return "Свободных аккаунтов пока нет. Обратитесь к владельцу сервиса.";
  return signUp
    ? "Не удалось создать аккаунт. Проверьте данные. Если аккаунт уже есть, войдите."
    : "Не удалось войти. Проверьте почту и пароль.";
}

export function AuthButton({ children, initialMode = "sign-in" }: { children: ReactNode; initialMode?: AuthMode }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const passwordHintId = useId();
  const signUp = mode === "sign-up";

  const changeOpen = (value: boolean): void => {
    if (pending) return;
    setOpen(value);
    if (value) { setMode(initialMode); setError(""); }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    setError("");
    if (signUp && !name) { setError("Введите имя."); return; }
    if (signUp && password !== form.get("confirmPassword")) {
      setError("Пароли не совпадают.");
      return;
    }
    setPending(true);
    try {
      const result = signUp
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(failureMessage(result.error, signUp));
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
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{signUp ? "Регистрация в Rimo" : "Вход в Rimo"}</DialogTitle>
          <DialogDescription>
            {signUp ? "Создайте аккаунт для своих досок." : "Войдите, чтобы открыть свои доски."}
            {" Ученики открывают доску по приглашению."}
          </DialogDescription>
        </DialogHeader>
        <form key={mode} onSubmit={onSubmit} aria-busy={pending} className="space-y-4">
          {signUp && (
            <label className="block space-y-2 text-sm">
              <span>Имя</span>
              <Input name="name" autoComplete="name" required maxLength={80} disabled={pending} />
            </label>
          )}
          <label className="block space-y-2 text-sm">
            <span>Почта</span>
            <Input name="email" type="email" autoComplete="username" required maxLength={254} disabled={pending} />
          </label>
          <label className="block space-y-2 text-sm">
            <span>Пароль</span>
            <Input name="password" type="password" autoComplete={signUp ? "new-password" : "current-password"}
              minLength={signUp ? 12 : undefined} maxLength={signUp ? 128 : undefined}
              aria-describedby={signUp ? passwordHintId : undefined} required disabled={pending} />
          </label>
          {signUp && (
            <>
              <p id={passwordHintId} className="text-sm text-muted-foreground">Не менее 12 символов.</p>
              <label className="block space-y-2 text-sm">
                <span>Повторите пароль</span>
                <Input name="confirmPassword" type="password" autoComplete="new-password"
                  required minLength={12} maxLength={128} disabled={pending} />
              </label>
            </>
          )}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {signUp ? (pending ? "Создаём аккаунт…" : "Создать аккаунт") : (pending ? "Входим…" : "Войти")}
          </Button>
        </form>
        <Button type="button" variant="link" disabled={pending} onClick={() => {
          setMode(signUp ? "sign-in" : "sign-up"); setError("");
        }}>
          {signUp ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Зарегистрироваться"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
