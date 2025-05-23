"use client";

import { useTranslation } from "@/hooks/use-translation";
import { Plus } from "lucide-react";
import { OrganizationProfile } from "@clerk/nextjs";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const InviteButton = () => {
  const { t } = useTranslation();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="h-4 w-4 mr-2" />
          {t("inviteButton.label")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[930px] justify-center">
        <DialogTitle className="text-lg font-semibold">
          {t("inviteButton.title")}
        </DialogTitle>
        <OrganizationProfile routing="hash" />
      </DialogContent>
    </Dialog>
  );
};
