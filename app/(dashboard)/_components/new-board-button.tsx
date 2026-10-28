"use client";

import { toast } from "sonner";
import { boardApi } from "@/lib/api-client";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/use-translation";

export const NewBoardButton = () => {
  const { mutate: createBoard, pending } = useApiMutation(boardApi.create);
  const router = useRouter();
  const { t } = useTranslation();

  const onClick = async () => {
    try {
      const defaultTitle = t("newBoard.defaultTitle");
      const board = await createBoard({ title: defaultTitle });

      toast.success(t("newBoard.toastSuccess"));
      router.push(`/board/${board.id}`);
    } catch {
      toast.error(t("newBoard.toastError"));
    }
  };

  return (
    <button
      disabled={pending}
      onClick={onClick}
      className={cn(
        "group col-span-1 aspect-[100/130] bg-gradient-to-br from-green-500 via-green-600 to-green-700 rounded-lg flex flex-col items-center justify-center py-6 transform transition duration-200 ease-out hover:scale-105 hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-green-300 focus:ring-offset-2",
        pending && "cursor-not-allowed opacity-75"
      )}
    >
      <Plus
        className="h-12 w-12 text-white stroke-2 transition-transform duration-200 ease-out group-hover:rotate-45"
      />
      <p className="text-white text-sm font-semibold mt-2 select-none">
        {t("newBoard.label")}
      </p>
    </button>
  );
};
