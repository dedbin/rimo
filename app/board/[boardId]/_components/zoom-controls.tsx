"use client";

import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";
import { useTranslation } from "@/hooks/use-translation";
import { Maximize } from "lucide-react";

interface ZoomControlsProps {
  scale: number;
  onFitToScreen: () => void;
}

export const ZoomControls = ({ scale, onFitToScreen }: ZoomControlsProps) => {
  const { t } = useTranslation();

  return (
    <div className="absolute bottom-2 right-2 flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-2">
      <span className="text-sm font-medium select-none w-10 text-center">
        {Math.round(scale * 100)}%
      </span>
      <Hint label={t("zoomControls.fitToScreen") as string} side="top" sideOffset={10}>
        <Button variant="board" size="icon" onClick={onFitToScreen}>
          <Maximize className="w-4 h-4" />
        </Button>
      </Hint>
    </div>
  );
};

export const ZoomControlsSkeleton = () => (
  <div className="absolute bottom-2 right-2 flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-2 pointer-events-none">
    <div className="h-4 w-8 bg-muted animate-pulse rounded" />
    <div className="h-8 w-8 bg-muted animate-pulse rounded" />
  </div>
);
