"use client";

import { useTranslation } from "@/hooks/use-translation";
import { Plus } from "lucide-react";
import { CreateOrganization } from "@clerk/nextjs";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const NewButton = () => { //TODO make it prettier
  const { t } = useTranslation();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10 transition"
          aria-label={t("newButton.createOrg")}
        >
          <Plus className="h-6 w-6" />
        </Button>
      </DialogTrigger>

      <DialogContent
        className="
          bg-white p-6 rounded-2xl shadow-xl
          max-w-md w-full
          flex flex-col items-center justify-center
        "
      >
        <DialogHeader className="flex items-center justify-between mb-4 w-full">
          <DialogTitle className="text-xl font-semibold">
            {t("newButton.dialogTitle")}
          </DialogTitle>
          <DialogClose className="text-gray-500 hover:text-gray-700 transition" />
        </DialogHeader>

        <div className="flex flex-col items-center justify-center gap-6 w-full">
          <CreateOrganization
            routing="hash"
            appearance={{
              elements: {
                logoBox: { display: "none" },
                titleBox: { display: "none" },
                descriptionBox: { display: "none" },
              },
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
