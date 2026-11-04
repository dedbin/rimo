"use client";

import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";
import { useTranslation } from "@/hooks/use-translation";
import { Maximize, Move } from "lucide-react";

interface ZoomControlsProps {
  scale: number;
  onFitToScreen: () => void;
  autoPanEnabled: boolean;
  onToggleAutoPan: () => void;
}

export const ZoomControls = ({ scale, onFitToScreen, autoPanEnabled, onToggleAutoPan }: ZoomControlsProps) => {
  const { t } = useTranslation();

  return (
    <div className="absolute bottom-2 right-2 flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-2">
      <span className="text-sm font-medium select-none w-10 text-center">
        {Math.round(scale * 100)}%
      </span>
      <Hint label={t(autoPanEnabled ? "zoomControls.autoPanEnabled" : "zoomControls.autoPanDisabled") as string}
        side="top" sideOffset={10}>
        <Button variant={autoPanEnabled ? "boardActive" : "board"} size="icon"
          className="hidden [@media(any-pointer:fine)]:inline-flex"
          aria-label={t("zoomControls.autoPan") as string} aria-pressed={autoPanEnabled}
          onClick={onToggleAutoPan}>
          <Move className="w-4 h-4" />
        </Button>
      </Hint>
      <Hint label={t("zoomControls.fitToScreen") as string} side="top" sideOffset={10}>
        <Button variant="board" size="icon" aria-label={t("zoomControls.fitToScreen") as string} onClick={onFitToScreen}>
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
