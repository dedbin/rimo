"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Camera } from "@/types/board-canvas";
import { useBoardBounds } from "@/hooks/use-board-bounds";

export function useCanvasCamera(svgRef: RefObject<SVGSVGElement | null>) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const cameraRef = useRef(camera);
  const animation = useRef<number | null>(null);
  const bounds = useBoardBounds();
  const updateCamera = useCallback((next: Camera) => {
    cameraRef.current = next;
    setCamera(next);
  }, []);
  const animateCameraTo = useCallback((target: Camera, duration = 250) => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    const initial = cameraRef.current;
    const start = performance.now();
    const frame = () => {
      const progress = Math.min((performance.now() - start) / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      updateCamera({
        x: initial.x + (target.x - initial.x) * eased,
        y: initial.y + (target.y - initial.y) * eased,
        scale: initial.scale + (target.scale - initial.scale) * eased,
      });
      animation.current = progress < 1 ? requestAnimationFrame(frame) : null;
    };
    animation.current = requestAnimationFrame(frame);
  }, [updateCamera]);
  const fitToScreen = useCallback(() => {
    const svg = svgRef.current;
    if (!bounds || !svg) return;
    const width = svg.clientWidth;
    const height = svg.clientHeight;
    const scale = Math.max(0.1, Math.min(4, (width - 80) / Math.max(bounds.width, 1), (height - 80) / Math.max(bounds.height, 1)));
    animateCameraTo({
      scale, x: (width - bounds.width * scale) / 2 - bounds.x * scale,
      y: (height - bounds.height * scale) / 2 - bounds.y * scale,
    });
  }, [bounds, svgRef, animateCameraTo]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = cameraRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = svg.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const scale = Math.max(0.1, Math.min(4, current.scale * Math.exp(-event.deltaY * 0.003)));
        updateCamera({ scale, x: x - (x - current.x) / current.scale * scale,
          y: y - (y - current.y) / current.scale * scale });
      } else updateCamera({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [svgRef, updateCamera]);

  useEffect(() => () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
  }, []);
  return { camera, cameraRef, updateCamera, animateCameraTo, fitToScreen };
}
