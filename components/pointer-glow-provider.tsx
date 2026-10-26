"use client";
import { ReactNode } from "react";
import { usePointerGlow } from "@/hooks/use-pointer-glow";

export function PointerGlowProvider({ children }: { children: ReactNode }) {
  usePointerGlow();
  return <>{children}</>;
}