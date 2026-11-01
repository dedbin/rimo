import type { Camera, Point } from "../../types/board-canvas";

export const LASER_MAX_POINTS = 32;
export const LASER_LIFETIME_MS = 1000;
export const PRESENTATION_INTERVAL_MS = 50;

export interface PresentationCamera {
  center: Point;
  scale: number;
  following: number | null;
}

export interface LaserPresence {
  sequence: number;
  points: Point[];
}

interface Viewport { width: number; height: number }
interface FollowParticipant { connectionId: number; presence: { camera?: PresentationCamera | null } }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
}

function point(value: unknown): Point | null {
  return record(value) && coordinate(value.x) && coordinate(value.y) ? { x: value.x, y: value.y } : null;
}

export function parsePresentationCamera(value: unknown): PresentationCamera | null {
  if (!record(value)) return null;
  const center = point(value.center);
  if (!center || typeof value.scale !== "number" || !Number.isFinite(value.scale) || value.scale < 0.1 || value.scale > 4) return null;
  if (value.following !== null && (typeof value.following !== "number" || !Number.isSafeInteger(value.following) || value.following < 0)) return null;
  return { center, scale: value.scale, following: value.following as number | null };
}

export function parseLaserPresence(value: unknown): LaserPresence | null {
  if (!record(value) || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence <= 0) return null;
  if (!Array.isArray(value.points) || !value.points.length || value.points.length > LASER_MAX_POINTS) return null;
  const points = value.points.map(point);
  return points.every((entry): entry is Point => entry !== null) ? { sequence: value.sequence, points } : null;
}

export function presentationFromCamera(camera: Camera, viewport: Viewport, following: number | null): PresentationCamera {
  return { center: { x: (viewport.width / 2 - camera.x) / camera.scale, y: (viewport.height / 2 - camera.y) / camera.scale },
    scale: camera.scale, following };
}

export function cameraFromPresentation(camera: PresentationCamera, viewport: Viewport): Camera {
  return { x: viewport.width / 2 - camera.center.x * camera.scale,
    y: viewport.height / 2 - camera.center.y * camera.scale, scale: camera.scale };
}

export function resolveFollowCamera(selfId: number, targetId: number, participants: readonly FollowParticipant[]): PresentationCamera | null {
  const seen = new Set([selfId]);
  const peers = new Map(participants.map((participant) => [participant.connectionId, participant]));
  let current = targetId;
  while (!seen.has(current)) {
    seen.add(current);
    const camera = peers.get(current)?.presence.camera;
    if (!camera) return null;
    if (camera.following === null) return camera;
    current = camera.following;
  }
  return null;
}
