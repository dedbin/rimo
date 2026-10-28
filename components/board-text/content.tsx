"use client";

import { CSSProperties, lazy, Suspense, useEffect, useRef } from "react";
import { useBoardRuntime, useConnectionState, useRichText, useSelection } from "@/lib/collaboration/react";
import { renderRichText } from "@/lib/board/rich-text/renderer";
import { useBoardText } from "./provider";
import { useContentHeight } from "./use-content-height";
import styles from "./styles.module.css";
import "katex/dist/katex.min.css";

const ActiveTextEditor = lazy(() => import("./editor").then((module) => ({ default: module.ActiveTextEditor })));

interface Props {
  id: string;
  style?: CSSProperties;
  className?: string;
  minHeight: number;
  onHeight: (height: number) => void;
}

export function RichTextContent({ id, style, className, minHeight, onHeight }: Props) {
  const runtime = useBoardRuntime();
  const connection = useConnectionState();
  const content = useRichText(id);
  const selection = useSelection();
  const { activeId, activate } = useBoardText();
  const element = useRef<HTMLDivElement>(null);
  const measured = useRef<number | null>(null);
  const active = activeId === id;
  const selected = selection.includes(id);
  const canMeasure = runtime.board.canEdit && connection.synced && connection.connected;
  useContentHeight(element, (height) => {
    const next = Math.max(minHeight, height);
    measured.current = next;
    onHeight(next);
    if (selected) runtime.board.setMeasuredTextHeight(id, next);
  });
  useEffect(() => {
    if (selected && canMeasure && measured.current !== null) runtime.board.setMeasuredTextHeight(id, measured.current);
  }, [selected, canMeasure, runtime, id]);
  return <div ref={element} data-placeholder="Текст" data-board-text-id={id}
    className={`${styles.content} ${className ?? ""}`}
    style={{ ...style, minHeight, userSelect: active ? "text" : "none", cursor: active ? "text" : "inherit" }}
    onPointerDown={(event) => { if (active) event.stopPropagation(); }}
    onDoubleClick={(event) => { event.stopPropagation(); if (!active) activate(id); }}>
    {active ? <Suspense fallback={<>{renderRichText(content)}</>}><ActiveTextEditor id={id} /></Suspense> : renderRichText(content)}
  </div>;
}
