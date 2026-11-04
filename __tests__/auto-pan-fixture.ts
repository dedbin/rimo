import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { vi } from "vitest";

import { useCanvasAutoPan } from "@/app/board/[boardId]/_hooks/use-canvas-auto-pan";
import type { CanvasPointerSample } from "@/lib/board/pointer-sample";
import type { Camera } from "@/types/board-canvas";

interface Switches { enabled: boolean; blocked: boolean }
type PointerOptions = Partial<CanvasPointerSample> & Pick<MouseEventInit, "relatedTarget">;

export class AutoPanFixture {
  readonly svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  readonly body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  readonly frames = new Map<number, FrameRequestCallback>();
  readonly cameraRef: { current: Camera } = { current: { x: 10, y: 20, scale: 2 } };
  readonly calls: string[] = [];
  readonly refreshedCameras: Camera[] = [];
  readonly canPan = vi.fn<(sample: CanvasPointerSample) => boolean>(() => true);
  readonly updateCamera = vi.fn((next: Camera): void => {
    this.calls.push("camera");
    this.cameraRef.current = next;
  });
  readonly onCameraMoved = vi.fn<(sample: CanvasPointerSample) => void>(() => {
    this.calls.push("refresh");
    this.refreshedCameras.push({ ...this.cameraRef.current });
  });
  readonly captured = new Set<number>();
  readonly hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  hit: Element | null = this.body;
  now = 0;
  private sequence = 0;
  private readonly originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");

  constructor() {
    this.svg.append(this.body);
    document.body.append(this.svg);
    Object.assign(this.svg, {
      getBoundingClientRect: (): DOMRect => new DOMRect(20, 30, 1000, 700),
      hasPointerCapture: (id: number): boolean => this.captured.has(id),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true, value: vi.fn((): Element | null => this.hit),
    });
    vi.spyOn(performance, "now").mockImplementation(() => this.now);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback): number => {
      this.frames.set(++this.sequence, callback);
      return this.sequence;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number): void => { this.frames.delete(id); }));
  }

  setup(initial: Switches = { enabled: true, blocked: false }): RenderHookResult<ReturnType<typeof useCanvasAutoPan>, Switches> {
    const svgRef = { current: this.svg };
    return renderHook(({ enabled, blocked }: Switches) => useCanvasAutoPan({
      svgRef, cameraRef: this.cameraRef, enabled, blocked,
      canPan: this.canPan, updateCamera: this.updateCamera, onCameraMoved: this.onCameraMoved,
    }), { initialProps: initial });
  }

  pointer(type = "pointermove", options: PointerOptions = {}, target: EventTarget = this.body): MouseEvent {
    const sample: CanvasPointerSample = {
      pointerId: 7, pointerType: "mouse", clientX: 1010, clientY: 380,
      pressure: 0, buttons: 0, shiftKey: false, ...options,
    };
    const event = new MouseEvent(type, { bubbles: true, cancelable: true,
      clientX: sample.clientX, clientY: sample.clientY, buttons: sample.buttons,
      shiftKey: sample.shiftKey, relatedTarget: options.relatedTarget });
    Object.assign(event, { pointerId: sample.pointerId, pointerType: sample.pointerType,
      pressure: sample.pressure, isPrimary: true });
    act(() => { target.dispatchEvent(event); });
    return event;
  }

  advance(milliseconds = 16): void {
    this.now += milliseconds;
    const pending = [...this.frames.values()];
    this.frames.clear();
    act(() => pending.forEach((callback) => callback(this.now)));
  }

  runFrames(count = 3): void {
    for (let index = 0; index < count; index++) this.advance();
  }

  restore(): void {
    if (this.originalHitTest) Object.defineProperty(document, "elementFromPoint", this.originalHitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
    document.body.replaceChildren();
  }
}
