"use client";

import { useTranslation } from "@/hooks/use-translation";
import { DropdownMenuContentProps } from "@radix-ui/react-dropdown-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { Link2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api } from "@/convex/_generated/api";
import { ConfirmModal } from "./confirm-modal";
import { Button } from "./ui/button";
import { useRenameModal } from "@/store/use-rename-modal";

interface ActionsProps {
  children: React.ReactNode;
  side?: DropdownMenuContentProps["side"];
  sideOffset?: DropdownMenuContentProps["sideOffset"];
  id: string;
  title: string;
}

export const Actions = ({ children, side, sideOffset, id, title }: ActionsProps) => {
  const { t } = useTranslation();
  const { handleOpen } = useRenameModal();
  const { mutate: deleteBoard, pending } = useApiMutation(api.board.remove);

  const handleCopyLink = () => {
    const url = `${window.location.origin}/board/${id}`;
    navigator.clipboard.writeText(url)
      .then(() => {
        toast.success(t("actions.toastCopySuccess"));
      })
      .catch(() => {
        toast.error(t("actions.toastCopyError"));
      });
  };

  const handleDeleteBoard = () => {
    deleteBoard({ id })
      .then(() => {
        toast.success(t("actions.toastDeleteSuccess"));
      })
      .catch(() => {
        toast.error(t("actions.toastDeleteError"));
      });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onClick={(e) => e.stopPropagation()}
        side={side}
        sideOffset={sideOffset}
        className="w-56"
      >
        <DropdownMenuItem className="cursor-pointer p-3" onClick={handleCopyLink}>
          <Link2 className="mr-2 h-4 w-4"/>
          {t("actions.copyLink")}
        </DropdownMenuItem>

        <DropdownMenuItem className="cursor-pointer p-3" onClick={() => handleOpen(id, title)}>
          <Pencil className="mr-2 h-4 w-4"/>
          {t("actions.rename")}
        </DropdownMenuItem>

        <ConfirmModal
          header={t("actions.deleteHeader", { title })}
          description={t("actions.deleteDescription")}
          onConfirm={handleDeleteBoard}
          disabled={pending}
        >
          <Button
            className="cursor-pointer p-3 text-sm w-full justify-start font-normal hover:text-red-600 transition-colors duration-200"
            variant="ghost"
          >
            <Trash2 className="mr-2 h-4 w-4"/>
            {t("actions.deleteBoard")}
          </Button>
        </ConfirmModal>
      </DropdownMenuContent>
    </DropdownMenu>
);
};
