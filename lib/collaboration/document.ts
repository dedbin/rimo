import { nanoid } from "nanoid";
import * as Y from "yjs";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { Layer, LayerType, Point } from "@/types/board-canvas";
import { MAX_LAYERS, normalizeLayerOrder, parseLayer } from "@/lib/board/model";
import { getRichTextJson, textFragmentName, writeRichTextFragment } from "@/lib/board/rich-text/document";
import { plainTextDocument, validateRichTextDocument } from "@/lib/board/rich-text/validation";
import { RichTextDocument } from "@/lib/board/rich-text/types";
import { BoardFrame, FRAME_ORDER_ROOT, FRAME_ROOT, MAX_FRAMES, normalizeFrameOrder, parseFrame } from "@/lib/board/frames";

export interface BoardSnapshot {
  readonly layers: ReadonlyMap<string, Layer>;
  readonly layerIds: readonly string[];
  readonly frames: ReadonlyMap<string, BoardFrame>;
  readonly frameIds: readonly string[];
}

interface PendingTextHeight { readonly height: number; readonly baseline: number; readonly layer: Y.Map<unknown> }

export class BoardDocument {
  readonly doc: Y.Doc;
  readonly layers: Y.Map<Y.Map<unknown>>;
  readonly order: Y.Array<string>;
  readonly frames: Y.Map<Y.Map<unknown>>;
  readonly frameOrder: Y.Array<string>;
  readonly undoManager: Y.UndoManager;
  private readonly origin = Symbol("board-local-operation");
  private readonly listeners = new Set<() => void>();
  private readonly dirtyLayers = new Set<string>();
  private readonly dirtyTexts = new Set<string>();
  private readonly textRoots = new Map<Y.XmlFragment, string>();
  private readonly textSnapshots = new Map<string, RichTextDocument>();
  private readonly emptyText = plainTextDocument("");
  private readonly measurementOrigin = Symbol("text-measurement");
  private readonly pendingTextHeights = new Map<string, PendingTextHeight>();
  private cancelHeightFlush: (() => void) | null = null;
  private destroyed = false;
  private orderChanged = true;
  private framesChanged = true;
  private writable: boolean;
  private snapshot: BoardSnapshot = { layers: new Map(), layerIds: [], frames: new Map(), frameIds: [] };

  constructor(doc = new Y.Doc(), writable = true) {
    this.doc = doc;
    this.writable = writable;
    this.layers = doc.getMap<Y.Map<unknown>>("layers");
    this.order = doc.getArray<string>("layerIds");
    this.frames = doc.getMap<Y.Map<unknown>>(FRAME_ROOT);
    this.frameOrder = doc.getArray<string>(FRAME_ORDER_ROOT);
    this.undoManager = new Y.UndoManager([this.layers, this.order, this.frames, this.frameOrder], {
      trackedOrigins: new Set([this.origin, ySyncPluginKey]), captureTimeout: 500,
      captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false,
    });
    this.layers.observeDeep((events) => {
      for (const event of events) {
        if (event.target === this.layers && event instanceof Y.YMapEvent) {
          for (const key of event.keysChanged) this.dirtyLayers.add(key);
        } else if (typeof event.path[0] === "string") {
          this.dirtyLayers.add(event.path[0]);
        }
      }
    });
    this.order.observe(() => { this.orderChanged = true; });
    this.frames.observeDeep(() => { this.framesChanged = true; });
    this.frameOrder.observe(() => { this.framesChanged = true; });
    doc.on("afterTransaction", this.refresh);
    for (const id of this.layers.keys()) this.dirtyLayers.add(id);
    this.refresh();
  }

  getSnapshot = (): BoardSnapshot => this.snapshot;
  getLayer = (id: string): Layer | undefined => this.snapshot.layers.get(id);
  getRichText = (id: string): RichTextDocument => this.textSnapshots.get(id) ?? this.emptyText;
  getTextFragment(id: string): Y.XmlFragment {
    const fragment = this.doc.getXmlFragment(textFragmentName(id));
    if (!this.textRoots.has(fragment)) {
      this.textRoots.set(fragment, id);
      this.undoManager.addToScope(fragment);
      this.dirtyTexts.add(id);
    }
    return fragment;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setWritable(writable: boolean): void {
    this.writable = writable && !this.destroyed;
    if (!this.writable) this.cancelMeasuredTextHeights();
  }
  get canEdit(): boolean { return this.writable; }
  isLocalOrigin(origin: unknown): boolean { return origin === this.measurementOrigin || this.undoManager.trackedOrigins.has(origin); }

  private refresh = (transaction?: Y.Transaction): void => {
    for (const name of this.doc.share.keys()) {
      if (name.startsWith("text:")) this.getTextFragment(name.slice(5));
    }
    if (transaction) {
      for (const changed of transaction.changed.keys()) {
        let root = changed;
        while (root.parent) root = root.parent;
        const id = root instanceof Y.XmlFragment ? this.textRoots.get(root) : undefined;
        if (id) this.dirtyTexts.add(id);
      }
    }
    if (!this.dirtyLayers.size && !this.orderChanged && !this.dirtyTexts.size && !this.framesChanged) return;
    if (this.dirtyLayers.size || this.orderChanged) {
      const layers = new Map(this.snapshot.layers);
      for (const id of this.dirtyLayers) {
        const value = this.layers.get(id);
        const layer = value instanceof Y.Map ? parseLayer(value.toJSON()) : null;
        if (layer) layers.set(id, layer);
        else layers.delete(id);
      }
      this.snapshot = { ...this.snapshot, layers, layerIds: normalizeLayerOrder(this.order.toArray(), layers) };
    }
    if (this.framesChanged) {
      const frames = new Map<string, BoardFrame>();
      for (const [id, value] of this.frames) {
        const frame = value instanceof Y.Map ? parseFrame(value.toJSON()) : null;
        if (frame) frames.set(id, frame);
      }
      this.snapshot = { ...this.snapshot, frames, frameIds: normalizeFrameOrder(this.frameOrder.toArray(), frames) };
      this.framesChanged = false;
    }
    this.dirtyLayers.clear();
    this.orderChanged = false;
    for (const id of this.dirtyTexts) this.textSnapshots.set(id, getRichTextJson(this.doc, id));
    this.dirtyTexts.clear();
    for (const listener of this.listeners) listener();
  };

  transact(action: () => void): void {
    if (!this.writable) return;
    this.undoManager.stopCapturing();
    this.doc.transact(action, this.origin);
    this.undoManager.stopCapturing();
  }

  insert(input: readonly Layer[], richText: readonly (RichTextDocument | null)[] = []): string[] {
    if (!this.writable) return [];
    if (this.layers.size + input.length > MAX_LAYERS) throw new Error("Достигнут предел количества объектов");
    const checked = input.map(parseLayer);
    if (checked.some((layer) => !layer)) throw new Error("Некорректный объект доски");
    const content = checked.map((layer, index) => layer?.type === LayerType.Text || layer?.type === LayerType.Sticker
      ? richText[index] ? validateRichTextDocument(richText[index]) : plainTextDocument(layer.value ?? "") : null);
    const ids = checked.map(() => nanoid());
    this.transact(() => {
      checked.forEach((layer, index) => {
        const properties = Object.entries(layer!).filter(([key]) => !(content[index] && key === "value"));
        this.layers.set(ids[index], new Y.Map(properties));
        if (content[index]) writeRichTextFragment(this.getTextFragment(ids[index]), content[index]);
      });
      this.order.push(ids);
    });
    return ids;
  }

  update(ids: readonly string[], patch: Readonly<Record<string, unknown>>): void {
    this.transact(() => {
      for (const id of ids) this.updateInTransaction(id, patch);
    });
  }

  private updateInTransaction(id: string, patch: Readonly<Record<string, unknown>>): void {
    const layer = this.layers.get(id);
    if (!(layer instanceof Y.Map)) return;
    const next = parseLayer({ ...layer.toJSON(), ...patch });
    if (!next) return;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "value" && (next.type === LayerType.Text || next.type === LayerType.Sticker)) continue;
      if (value !== undefined && Object.hasOwn(next, key)) {
        layer.set(key, (next as unknown as Record<string, unknown>)[key]);
      }
    }
  }

  setMeasuredTextHeight(id: string, height: number): void {
    const layer = this.getLayer(id);
    if (!this.writable || !Number.isFinite(height) || height < 1 || height > 1_000_000 ||
      (layer?.type !== LayerType.Text && layer?.type !== LayerType.Sticker)) return;
    if (Math.abs(layer.height - height) < 1) {
      this.pendingTextHeights.delete(id);
      if (!this.pendingTextHeights.size) this.cancelMeasuredTextHeights();
      return;
    }
    const stored = this.layers.get(id);
    if (!(stored instanceof Y.Map)) return;
    const previous = this.pendingTextHeights.get(id);
    this.pendingTextHeights.set(id, { height, baseline: previous?.baseline ?? layer.height, layer: previous?.layer ?? stored });
    if (this.cancelHeightFlush) return;
    if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
      const frame = requestAnimationFrame(this.flushMeasuredTextHeights);
      this.cancelHeightFlush = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(this.flushMeasuredTextHeights, 16);
      this.cancelHeightFlush = () => clearTimeout(timer);
    }
  }

  private flushMeasuredTextHeights = (): void => {
    this.cancelHeightFlush = null;
    const pending = [...this.pendingTextHeights];
    this.pendingTextHeights.clear();
    if (!this.writable || this.destroyed || !pending.length) return;
    // One board update per frame; measurements persist without entering local undo.
    this.doc.transact(() => {
      for (const [id, measurement] of pending) {
        const layer = this.layers.get(id);
        if (layer !== measurement.layer || !(layer instanceof Y.Map) ||
            (layer.get("type") !== LayerType.Text && layer.get("type") !== LayerType.Sticker) ||
            layer.get("height") !== measurement.baseline || Math.abs(measurement.baseline - measurement.height) < 1) continue;
        layer.set("height", measurement.height);
      }
    }, this.measurementOrigin);
  };

  private cancelMeasuredTextHeights(): void {
    this.cancelHeightFlush?.();
    this.cancelHeightFlush = null;
    this.pendingTextHeights.clear();
  }

  translate(ids: readonly string[], delta: Point): void {
    if (delta.x === 0 && delta.y === 0) return;
    this.transact(() => {
      for (const id of ids) {
        const layer = this.layers.get(id);
        if (!(layer instanceof Y.Map)) continue;
        const x = layer.get("x");
        const y = layer.get("y");
        if (typeof x === "number" && typeof y === "number") {
          this.updateInTransaction(id, { x: x + delta.x, y: y + delta.y });
        }
      }
    });
  }

  remove(ids: readonly string[]): void {
    const removed = new Set(ids);
    this.transact(() => {
      for (const id of removed) this.layers.delete(id);
      for (let index = this.order.length - 1; index >= 0; index -= 1) {
        if (removed.has(this.order.get(index))) this.order.delete(index, 1);
      }
    });
  }

  reorder(ids: readonly string[], direction: "front" | "back"): void {
    const selection = new Set(ids);
    const current = this.snapshot.layerIds;
    const selected = current.filter((id) => selection.has(id));
    const rest = current.filter((id) => !selection.has(id));
    const next = direction === "front" ? [...rest, ...selected] : [...selected, ...rest];
    this.transact(() => {
      this.order.delete(0, this.order.length);
      this.order.push(next);
    });
  }

  createFrame(input: BoardFrame): string | null {
    if (!this.writable) return null;
    const frame = parseFrame(input);
    if (!frame) throw new Error("Некорректная область страницы");
    if (this.frames.size >= MAX_FRAMES) throw new Error("Достигнут предел количества областей");
    const id = nanoid();
    this.transact(() => {
      this.frames.set(id, new Y.Map(Object.entries(frame)));
      this.frameOrder.push([id]);
    });
    return id;
  }

  updateFrame(id: string, patch: Partial<BoardFrame>): void {
    const stored = this.frames.get(id);
    if (!this.writable || !(stored instanceof Y.Map)) return;
    const frame = parseFrame({ ...stored.toJSON(), ...patch });
    if (!frame) throw new Error("Некорректная область страницы");
    this.transact(() => {
      for (const key of Object.keys(patch)) {
        if (!Object.hasOwn(frame, key)) continue;
        const value = (frame as unknown as Record<string, unknown>)[key];
        if (stored.get(key) !== value) stored.set(key, value);
      }
    });
  }

  removeFrame(id: string): void {
    this.transact(() => {
      this.frames.delete(id);
      for (let index = this.frameOrder.length - 1; index >= 0; index -= 1) {
        if (this.frameOrder.get(index) === id) this.frameOrder.delete(index, 1);
      }
    });
  }

  reorderFrames(ids: readonly string[]): void {
    const ordered = normalizeFrameOrder(ids, this.snapshot.frames);
    this.transact(() => {
      this.frameOrder.delete(0, this.frameOrder.length);
      this.frameOrder.push([...ordered]);
    });
  }

  undo = (): void => { if (this.writable) this.undoManager.undo(); };
  redo = (): void => { if (this.writable) this.undoManager.redo(); };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setWritable(false);
    this.doc.off("afterTransaction", this.refresh);
    this.undoManager.destroy();
    this.listeners.clear();
    this.doc.destroy();
  }
}
