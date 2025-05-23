"use client";

import { useTranslation } from "@/hooks/use-translation";
import Image from "next/image";
import { CreateOrganization } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export const EmptyOrg = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <Image src="/empty-state.svg" alt="empty" width={200} height={200} />
      <h2 className="text-2xl font-semibold text-center mt-6">
        {t("emptyOrg.welcome")}
      </h2>
      <p className="text-muted-foreground text-sm text-center mt-2">
        {t("emptyOrg.description")}
      </p>
      <div className="mt-6">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="lg">
              {t("emptyOrg.createButton")}
            </Button>
          </DialogTrigger>
          <DialogContent className="border-none sm:max-w-[490px] justify-center">
            <DialogTitle className="mb-4 text-lg font-semibold">
              {t("emptyOrg.dialogTitle")}
            </DialogTitle>
            <CreateOrganization routing="hash" />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
