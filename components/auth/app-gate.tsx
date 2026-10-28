"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { canUseAccount } from "@/lib/verified-user";
import { Loading } from "@/components/auth/loading";
import { Button } from "@/components/ui/button";
import { EmailVerificationRequired } from "./email-verification-gate";
import { RimoNavbar } from "@/components/landing-navbar";
import { RimoHero } from "@/components/landing-hero";
import { RimoContent } from "@/components/landing-content";
import { RimoFooter } from "@/components/landing-footer";

export function AppGate({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession();
  const initialCheckComplete = useRef(false);
  useEffect(() => {
    if (!isPending) initialCheckComplete.current = true;
  }, [isPending]);
  // Better Auth marks every refetch without a session as pending. Keep the
  // landing forms mounted after the initial check so OTP state survives it.
  if (isPending && !initialCheckComplete.current) return <Loading />;
  if (error) return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <p role="alert">Не удалось проверить вход. Попробуйте ещё раз.</p>
      <Button onClick={() => void refetch()}>Повторить</Button>
    </div>
  );
  if (data && !canUseAccount(data.user)) {
    return <EmailVerificationRequired email={data.user.email} onVerified={async () => { await refetch(); }} />;
  }
  if (data) return children;
  return (
    <div className="min-h-full bg-zinc-900">
      <RimoNavbar /><RimoHero /><RimoContent /><RimoFooter />
    </div>
  );
}
