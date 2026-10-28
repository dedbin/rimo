"use client";

import { useState, type ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import { canUseAccount } from "@/lib/verified-user";
import { Button } from "@/components/ui/button";
import { EmailVerification } from "./email-verification";
import { Loading } from "./loading";

interface RequiredProps {
  email: string;
  onVerified: () => Promise<void>;
}

export function EmailVerificationRequired({ email, onVerified }: RequiredProps) {
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");

  const signOut = async (): Promise<void> => {
    if (pending || signingOut) return;
    setSigningOut(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      await onVerified();
    } catch {
      setError("Не удалось выйти из аккаунта. Попробуйте ещё раз.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="w-full max-w-md space-y-5 rounded-xl border p-6" aria-labelledby="email-verification-title">
        <div className="space-y-2">
          <h1 id="email-verification-title" className="text-xl font-semibold">Подтвердите почту</h1>
          <p className="text-sm text-muted-foreground">Подтвердите адрес один раз, чтобы продолжить работу. Ваши доски сохранены.</p>
        </div>
        <EmailVerification key={email} email={email} onVerified={onVerified} onPendingChange={setPending} />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button type="button" variant="link" className="w-full" disabled={pending || signingOut}
          onClick={() => void signOut()}>{signingOut ? "Выходим…" : "Выйти из аккаунта"}</Button>
      </section>
    </div>
  );
}

export function EmailVerificationGate({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession();
  if (isPending) return fallback ?? <Loading />;
  if (error) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <p role="alert">Не удалось проверить вход. Попробуйте ещё раз.</p>
      <Button onClick={() => void refetch()}>Повторить</Button>
    </div>
  );
  if (data && !canUseAccount(data.user)) {
    return <EmailVerificationRequired email={data.user.email} onVerified={async () => { await refetch(); }} />;
  }
  return children;
}
