"use client";

import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserButton() {
  const { data } = authClient.useSession();
  const [pending, setPending] = useState(false);
  if (!data) return null;

  const signOut = async () => {
    setPending(true);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      window.location.assign("/");
    } catch {
      toast.error("Не удалось выйти из аккаунта");
      setPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="rounded-full" aria-label="Аккаунт">
          {data.user.name.charAt(0).toUpperCase() || "R"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="max-w-64 truncate p-2 text-sm">{data.user.name}</div>
        <DropdownMenuItem disabled={pending} onSelect={() => void signOut()}>
          Выйти
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
