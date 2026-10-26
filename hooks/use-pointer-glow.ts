"use client";
import { useEffect } from "react";

export const usePointerGlow = () => {
  useEffect(() => {
    const syncPointer = ({ x, y }: PointerEvent) => {
      const xp = (x / window.innerWidth).toFixed(2);
      const yp = (y / window.innerHeight).toFixed(2);
      document.documentElement.style.setProperty("--x", x.toFixed(2));
      document.documentElement.style.setProperty("--xp", xp);
      document.documentElement.style.setProperty("--y", y.toFixed(2));
      document.documentElement.style.setProperty("--yp", yp);
    };

    document.body.addEventListener("pointermove", syncPointer);
    return () => {
      document.body.removeEventListener("pointermove", syncPointer);
    };
  }, []);
};