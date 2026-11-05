export interface CanvasPointerSample {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly pressure: number;
  readonly buttons: number;
  readonly shiftKey?: boolean;
}
