"use client";

import { useEffect, useRef, useState } from "react";

import { cameraFromPresentation, parsePresentationCamera, presentationFromCamera, PRESENTATION_INTERVAL_MS, resolveFollowCamera } from "@/lib/collaboration/presentation";
import type { PresentationCamera } from "@/lib/collaboration/presentation";
import { useBoardRuntime, useConnectionState, useOthers } from "@/lib/collaboration/react";
import { useEvent } from "@/lib/collaboration/use-event";
import type { Camera } from "@/types/board-canvas";

interface Options {
  camera: Camera;
  viewport: { width: number; height: number };
  applyRemoteCamera: (camera: Camera) => void;
}

function sameCamera(first: PresentationCamera | null, second: PresentationCamera | null): boolean {
  return first === second || !!first && !!second && first.scale === second.scale && first.following === second.following &&
    first.center.x === second.center.x && first.center.y === second.center.y;
}

export function useCanvasFollow({ camera, viewport, applyRemoteCamera }: Options) {
  const runtime = useBoardRuntime();
  const others = useOthers();
  const connection = useConnectionState();
  const [followingId, setFollowingId] = useState<number | null>(null);
  const lastPublished = useRef<PresentationCamera | null>(null);
  const pending = useRef<PresentationCamera | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef(-Infinity);
  const selfId = runtime.board.doc.clientID;

  const stopFollowing = useEvent(() => setFollowingId(null));
  const toggleFollow = useEvent((id: number) => {
    if (followingId === id) { stopFollowing(); return; }
    if (connection.connected && connection.synced && resolveFollowCamera(selfId, id, others)) setFollowingId(id);
  });

  const publish = useEvent(() => {
    timer.current = null;
    const state = runtime.getState();
    if (!state.connected || !state.synced || state.error) return;
    if (sameCamera(lastPublished.current, pending.current)) return;
    lastSent.current = performance.now();
    lastPublished.current = pending.current;
    runtime.updatePresence({ camera: pending.current });
  });

  useEffect(() => {
    if (!connection.connected || !connection.synced || connection.error) return;
    // A follower advertises its target once; remote camera frames are resolved
    // from the terminal leader rather than echoed back through every follower.
    pending.current = parsePresentationCamera(followingId !== null && lastPublished.current
      ? { ...lastPublished.current, following: followingId }
      : presentationFromCamera(camera, viewport, followingId));
    if (timer.current !== null || sameCamera(lastPublished.current, pending.current)) return;
    const delay = PRESENTATION_INTERVAL_MS - (performance.now() - lastSent.current);
    if (delay <= 0) publish();
    else timer.current = setTimeout(publish, delay);
  }, [camera, viewport, followingId, connection.connected, connection.synced, connection.error, publish]);

  useEffect(() => {
    if (followingId === null) return;
    const target = resolveFollowCamera(selfId, followingId, others);
    if (!target || !connection.connected || !connection.synced) { stopFollowing(); return; }
    const desired = cameraFromPresentation(target, viewport);
    if (Math.abs(desired.x - camera.x) > 0.000001 || Math.abs(desired.y - camera.y) > 0.000001 || desired.scale !== camera.scale) {
      applyRemoteCamera(desired);
    }
  }, [followingId, selfId, others, viewport, camera, connection.connected, connection.synced, applyRemoteCamera, stopFollowing]);

  useEffect(() => {
    const clear = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      lastPublished.current = null;
      lastSent.current = -Infinity;
      runtime.updatePresence({ camera: null });
    };
    const unsubscribe = runtime.subscribeState(() => {
      const state = runtime.getState();
      if (state.connected && state.synced && !state.error) return;
      stopFollowing();
      clear();
    });
    return () => { unsubscribe(); clear(); };
  }, [runtime, stopFollowing]);

  return { followingId, toggleFollow, stopFollowing };
}
