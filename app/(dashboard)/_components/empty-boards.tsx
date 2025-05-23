"use client";

import { useTranslation } from "@/hooks/use-translation";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import { api } from "@/convex/_generated/api";
import { useOrganization } from "@clerk/nextjs";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export const EmptyBoards = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const { organization } = useOrganization();
  const { mutate: createBoard, pending } = useApiMutation(api.board.create);

  const onClick = () => {
    if (!organization) return;

    createBoard({
      title: "Untitled board",
      orgId: organization.id,
    })
      .then((id) => {
        toast.success(t("emptyBoards.toastSuccess"));
        router.push(`/board/${id}`);
      })
      .catch((error) => {
        console.error("error creating board:", error);
        toast.error(t("emptyBoards.toastError"));
      });
  };

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <Image src="/empty-boards.svg" alt="empty" width={200} height={200} />
      <h2 className="text-2xl font-semibold text-center mt-6">
        {t("emptyBoards.title")}
      </h2>
      <p className="text-muted-foreground text-sm text-center mt-2">
        {t("emptyBoards.description")}
      </p>
      <div className="mt-6">
        <Button disabled={pending} onClick={onClick} size="lg">
          {pending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("emptyBoards.creating")}
            </>
          ) : (
            t("emptyBoards.create")
          )}
        </Button>
      </div>
    </div>
);
};
