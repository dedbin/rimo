"use client";

import { useEffect, useRef, useState } from "react";

import { LASER_LIFETIME_MS } from "@/lib/collaboration/presentation";
import type { LaserPresence as LaserState } from "@/lib/collaboration/presentation";
import { useOthers, useSelf } from "@/lib/collaboration/react";
import { connectionIdToColor } from "@/lib/utils";

interface Trail { laser: LaserState; receivedAt: number }

function LaserTrace({ id, laser, scale }: { id: number; laser: LaserState | null | undefined; scale: number }) {
  const trail = useRef<Trail | null>(null);
  const highestSequence = useRef(0);
  const [frameTime, setFrameTime] = useState({ now: 0 });

  useEffect(() => {
    if (!laser) trail.current = null;
    else if (laser.sequence > highestSequence.current) {
      highestSequence.current = laser.sequence;
      trail.current = { laser, receivedAt: performance.now() };
    }
    let frame: number | null = null;
    const tick = () => {
      const time = performance.now();
      setFrameTime({ now: time });
      if (trail.current && time - trail.current.receivedAt < LASER_LIFETIME_MS) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [laser]);

  const current = trail.current;
  if (!current) return null;
  const opacity = Math.max(0, Math.min(1, 1 - (frameTime.now - current.receivedAt) / LASER_LIFETIME_MS));
  if (!opacity) return null;
  const points = current.laser.points;
  const last = points.at(-1)!;
  const color = connectionIdToColor(id);
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
  return <g data-laser-id={id} opacity={opacity}>
    <path data-laser-trail="true" d={path} stroke={color} strokeWidth={4 / scale}
      strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.6} />
    <circle data-laser-dot="true" cx={last.x} cy={last.y} r={5 / scale}
      fill={color} stroke="white" strokeWidth={1.5 / scale} />
  </g>;
}

export function LaserPresence({ scale }: { scale: number }) {
  const self = useSelf();
  const others = useOthers();
  return <g pointerEvents="none" aria-hidden="true" data-laser-overlay="true">
    <LaserTrace id={self.connectionId} laser={self.presence.laser} scale={scale} />
    {others.map((participant) => <LaserTrace key={participant.connectionId} id={participant.connectionId}
      laser={participant.presence.laser} scale={scale} />)}
  </g>;
}
