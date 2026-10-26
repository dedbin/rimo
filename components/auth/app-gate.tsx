"use client";

import type { ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Loading } from "@/components/auth/loading";
import { Button } from "@/components/ui/button";
import { RimoNavbar } from "@/components/landing-navbar";
import { RimoHero } from "@/components/landing-hero";
import { RimoContent } from "@/components/landing-content";
import { RimoFooter } from "@/components/landing-footer";

export function AppGate({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession();
  if (isPending) return <Loading />;
  if (error) return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <p role="alert">Не удалось проверить вход. Попробуйте ещё раз.</p>
      <Button onClick={() => void refetch()}>Повторить</Button>
    </div>
  );
  if (data) return children;
  return (
    <div className="min-h-full bg-zinc-900">
      <RimoNavbar /><RimoHero /><RimoContent /><RimoFooter />
    </div>
  );
}
