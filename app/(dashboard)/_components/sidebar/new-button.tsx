"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { boardApi } from "@/lib/api-client";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export const NewButton = () => {
  const { data: session } = authClient.useSession();
  const { mutate, pending } = useApiMutation(boardApi.create);
  const router = useRouter();
  if (!session || session.user.isAnonymous) return null;

  const createBoard = async () => {
    try {
      const board = await mutate({ title: "Новая доска" });
      router.push(`/board/${board.id}`);
    } catch {
      toast.error("Не удалось создать доску");
    }
  };
  return (
    <Button variant="ghost" size="icon" disabled={pending}
      onClick={() => void createBoard()}
      className="text-white hover:bg-white/10 transition" aria-label="Создать доску">
      <Plus className="h-6 w-6" />
    </Button>
  );
};
