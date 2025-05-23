"use client";

import { useTranslation } from "@/hooks/use-translation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogClose,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog";
import { useRenameModal } from "@/store/use-rename-modal";
import { useEffect, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

export const RenameModal = () => {
  const { t } = useTranslation();
  const { mutate: renameBoard, pending } = useApiMutation(api.board.update);
  const { isOpen, values, handleClose } = useRenameModal();
  const [title, setTitle] = useState(values.title);

  useEffect(() => {
    setTitle(values.title);
  }, [values.title]);

  const onSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    renameBoard({ id: values.id, title })
      .then(() => {
        toast.success(t("renameModal.toastSuccess"));
        handleClose();
      })
      .catch(() => {
        toast.error(t("renameModal.toastError"));
      });
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("renameModal.title")}</DialogTitle>
          <DialogDescription>{t("renameModal.description")}</DialogDescription>
          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              disabled={pending}
              required
              maxLength={50}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("renameModal.placeholder")}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("renameModal.cancel")}
                </Button>
              </DialogClose>
              <Button disabled={pending} type="submit" variant="default">
                {t("renameModal.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
};
