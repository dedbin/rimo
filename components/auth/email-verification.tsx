"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface EmailVerificationProps {
  email: string;
  onVerified: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}

type VerificationError = { code?: string; status?: number };

function messageFor(error: VerificationError): string {
  if (error.status === 429) return "Слишком много запросов. Дождитесь окончания отсчёта и попробуйте ещё раз.";
  if (error.code === "VERIFICATION_REQUIRED" || error.code === "VERIFICATION_EXPIRED") {
    return "Вернитесь к форме и войдите с почтой и паролем, чтобы запросить код.";
  }
  if (error.code === "OTP_EXPIRED") return "Срок действия кода истёк. Запросите новый код.";
  if (error.code === "TOO_MANY_ATTEMPTS") return "Попытки закончились. Запросите новый код.";
  if (error.code === "INVALID_OTP") return "Код не подошёл. Проверьте шесть цифр из последнего письма.";
  if (error.code === "OWNER_LIMIT_REACHED") return "Свободных аккаунтов пока нет. Когда место появится, запросите новый код.";
  if (error.code === "MAIL_SEND_FAILED") return "Не удалось отправить письмо. Попробуйте отправить код ещё раз.";
  return "Не удалось подтвердить почту. Попробуйте ещё раз.";
}

function retryAfter(response?: Response): number {
  const header = response?.headers.get("Retry-After");
  if (!header) return 60;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.ceil(seconds), 86_400);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1, Math.min(Math.ceil((date - Date.now()) / 1000), 86_400)) : 60;
}

function useSecondsUntil(deadline: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (deadline <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function EmailVerification({ email, onVerified, onPendingChange }: EmailVerificationProps) {
  const [otp, setOtp] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [needsNewCode, setNeedsNewCode] = useState(false);
  const busy = useRef(false);
  const initialSend = useRef(false);
  const descriptionId = useId();
  const errorId = useId();
  const resendSeconds = useSecondsUntil(resendAt);
  const retrySeconds = useSecondsUntil(retryAt);

  const changePending = (value: boolean): void => {
    busy.current = value;
    setPending(value);
    onPendingChange?.(value);
  };

  const sendCode = async (): Promise<void> => {
    if (busy.current || resendAt > Date.now()) return;
    changePending(true);
    setError("");
    setNotice("");
    setResendAt(Date.now() + 60_000);
    let waitSeconds = 60;
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" }, {
        onError: (context) => { waitSeconds = retryAfter(context.response); },
      });
      if (result.error) {
        if (result.error.status === 429) setResendAt(Date.now() + waitSeconds * 1000);
        setError(messageFor(result.error));
        return;
      }
      setOtp("");
      setNeedsNewCode(false);
      setResendAt(Date.now() + 60_000);
      setNotice("Если адрес ожидает подтверждения, письмо с кодом отправлено. Проверьте также папку «Спам».");
    } catch {
      setError("Не удалось отправить письмо. Проверьте соединение и попробуйте ещё раз.");
    } finally {
      changePending(false);
    }
  };

  useEffect(() => {
    if (initialSend.current) return;
    initialSend.current = true;
    void sendCode();
    // This component is keyed by email; send only once when the confirmation step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verifyCode = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy.current || needsNewCode || retryAt > Date.now()) return;
    if (!/^\d{6}$/.test(otp)) { setError("Введите шестизначный код из письма."); return; }
    changePending(true);
    setError("");
    let waitSeconds = 60;
    try {
      const result = await authClient.emailOtp.verifyEmail({ email, otp }, {
        onError: (context) => { waitSeconds = retryAfter(context.response); },
      });
      if (result.error) {
        if (result.error.status === 429) setRetryAt(Date.now() + waitSeconds * 1000);
        if (["OTP_EXPIRED", "TOO_MANY_ATTEMPTS", "OWNER_LIMIT_REACHED"].includes(result.error.code ?? "")) {
          setNeedsNewCode(true);
        }
        setError(messageFor(result.error));
        return;
      }
      await onVerified();
    } catch {
      setError("Сервис временно недоступен. Попробуйте ещё раз.");
    } finally {
      changePending(false);
    }
  };

  return (
    <div className="space-y-4">
      <p id={descriptionId} className="text-sm text-muted-foreground">
        Введите код из письма для <span className="break-all font-medium text-foreground">{email}</span>.
        {" Код действует 10 минут. Доступно 5 попыток."}
      </p>
      <form onSubmit={verifyCode} aria-busy={pending} className="space-y-4">
        <label className="block space-y-2 text-sm">
          <span>Код из письма</span>
          <Input name="otp" type="text" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" minLength={6} maxLength={6} required value={otp} disabled={pending}
            aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`} aria-invalid={!!error}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onPaste={(event) => {
              event.preventDefault();
              setOtp(event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6));
            }}
            className="text-center text-lg tracking-[0.3em]" />
        </label>
        {error && <p id={errorId} role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        <Button type="submit" className="w-full" disabled={pending || otp.length !== 6 || needsNewCode || retrySeconds > 0}>
          {pending ? "Подождите…" : retrySeconds > 0 ? `Повторить через ${retrySeconds} с` : "Подтвердить почту"}
        </Button>
      </form>
      <Button type="button" variant="outline" className="w-full" disabled={pending || resendSeconds > 0}
        onClick={() => void sendCode()}>
        {resendSeconds > 0 ? `Отправить ещё раз через ${resendSeconds} с` : "Отправить код ещё раз"}
      </Button>
    </div>
  );
}
