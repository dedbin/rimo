import { nanoid } from "nanoid";
import * as Y from "yjs";
import { Layer, Point } from "@/types/board-canvas";
import { MAX_LAYERS, normalizeLayerOrder, parseLayer } from "@/lib/board/model";

export interface BoardSnapshot {
  readonly layers: ReadonlyMap<string, Layer>;
  readonly layerIds: readonly string[];
}

export class BoardDocument {
  readonly doc: Y.Doc;
  readonly layers: Y.Map<Y.Map<unknown>>;
  readonly order: Y.Array<string>;
  readonly undoManager: Y.UndoManager;
  private readonly origin = Symbol("board-local-operation");
  private readonly listeners = new Set<() => void>();
  private readonly dirtyLayers = new Set<string>();
  private orderChanged = true;
  private writable: boolean;
  private snapshot: BoardSnapshot = { layers: new Map(), layerIds: [] };

  constructor(doc = new Y.Doc(), writable = true) {
    this.doc = doc;
    this.writable = writable;
    this.layers = doc.getMap<Y.Map<unknown>>("layers");
    this.order = doc.getArray<string>("layerIds");
    this.undoManager = new Y.UndoManager([this.layers, this.order], {
      trackedOrigins: new Set([this.origin]), captureTimeout: 0,
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
    doc.on("afterTransaction", this.refresh);
    for (const id of this.layers.keys()) this.dirtyLayers.add(id);
    this.refresh();
  }

  getSnapshot = (): BoardSnapshot => this.snapshot;
  getLayer = (id: string): Layer | undefined => this.snapshot.layers.get(id);
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setWritable(writable: boolean): void { this.writable = writable; }
  get canEdit(): boolean { return this.writable; }
  isLocalOrigin(origin: unknown): boolean { return origin === this.origin || origin === this.undoManager; }

  private refresh = (): void => {
    if (!this.dirtyLayers.size && !this.orderChanged) return;
    const layers = new Map(this.snapshot.layers);
    for (const id of this.dirtyLayers) {
      const value = this.layers.get(id);
      const layer = value instanceof Y.Map ? parseLayer(value.toJSON()) : null;
      if (layer) layers.set(id, layer);
      else layers.delete(id);
    }
    this.dirtyLayers.clear();
    this.orderChanged = false;
    this.snapshot = { layers, layerIds: normalizeLayerOrder(this.order.toArray(), layers) };
    for (const listener of this.listeners) listener();
  };

  transact(action: () => void): void {
    if (!this.writable) return;
    this.doc.transact(action, this.origin);
  }

  insert(input: readonly Layer[]): string[] {
    if (!this.writable) return [];
    if (this.layers.size + input.length > MAX_LAYERS) throw new Error("Достигнут предел количества объектов");
    const checked = input.map(parseLayer);
    if (checked.some((layer) => !layer)) throw new Error("Некорректный объект доски");
    const ids = checked.map(() => nanoid());
    this.transact(() => {
      checked.forEach((layer, index) => {
        this.layers.set(ids[index], new Y.Map(Object.entries(layer!)));
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
      if (value !== undefined && Object.hasOwn(next, key)) {
        layer.set(key, (next as unknown as Record<string, unknown>)[key]);
      }
    }
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

  undo = (): void => { if (this.writable) this.undoManager.undo(); };
  redo = (): void => { if (this.writable) this.undoManager.redo(); };

  destroy(): void {
    this.doc.off("afterTransaction", this.refresh);
    this.undoManager.destroy();
    this.listeners.clear();
    this.doc.destroy();
  }
}
