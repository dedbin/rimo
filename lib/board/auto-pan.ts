import type { Camera, Point } from "@/types/board-canvas";

export const AUTO_PAN_EDGE_PX = 48;
export const AUTO_PAN_MAX_SPEED = 480;
export const AUTO_PAN_MAX_FRAME_MS = 32;

interface Bounds { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

export function edgePanVelocity(point: Point, bounds: Bounds): Point {
  const x = point.x - bounds.left;
  const y = point.y - bounds.top;
  if (![x, y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 ||
    x < 0 || y < 0 || x > bounds.width || y > bounds.height) return { x: 0, y: 0 };
  const speed = (position: number, size: number): number => {
    const zone = Math.min(AUTO_PAN_EDGE_PX, size / 2);
    if (position < zone) return -AUTO_PAN_MAX_SPEED * (1 - position / zone) ** 2;
    if (position > size - zone) return AUTO_PAN_MAX_SPEED * (1 - (size - position) / zone) ** 2;
    return 0;
  };
  const velocity = { x: speed(x, bounds.width), y: speed(y, bounds.height) };
  const limit = Math.max(1, Math.hypot(velocity.x, velocity.y) / AUTO_PAN_MAX_SPEED);
  return { x: velocity.x / limit, y: velocity.y / limit };
}

export function stepEdgePan(camera: Camera, velocity: Point, deltaMs: number): Camera {
  const seconds = Number.isFinite(deltaMs) ? Math.max(0, Math.min(AUTO_PAN_MAX_FRAME_MS, deltaMs)) / 1000 : 0;
  return { ...camera, x: camera.x - velocity.x * seconds, y: camera.y - velocity.y * seconds };
}
