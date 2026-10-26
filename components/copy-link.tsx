"use client";

import { useTranslation } from "@/hooks/use-translation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Menu, Link2 } from "lucide-react";
import { Hint } from "@/components/hint";
import { toast } from "sonner";
import type { ReactNode } from "react";

interface BoardCopyLinkActionProps {
  boardId: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  children?: ReactNode;
}

export const BoardCopyLinkAction = ({
  boardId,
  side = "bottom",
  sideOffset = 10,
  children,
}: BoardCopyLinkActionProps) => {
  const { t } = useTranslation();

  const handleCopyLink = () => {
    const url = `${window.location.origin}/board/${boardId}`;
    navigator.clipboard.writeText(url)
      .then(() => toast.success(t("copyLink.toastSuccess")))
      .catch(() => toast.error(t("copyLink.toastError")));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <div>
          <Hint label={t("copyLink.tooltip")} side={side} sideOffset={sideOffset}>
            <Button variant="board" size="icon" aria-label="Действия с доской">
              <Menu />
            </Button>
          </Hint>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onClick={(e) => e.stopPropagation()}
        side={side}
        sideOffset={sideOffset}
        className="w-56"
      >
        <DropdownMenuItem className="cursor-pointer p-3" onClick={handleCopyLink}>
          <Link2 className="mr-2 h-4 w-4" />
          {t("copyLink.menuItem")}
        </DropdownMenuItem>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
