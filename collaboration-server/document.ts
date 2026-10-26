import { isDeepStrictEqual } from "node:util";

import * as Y from "yjs";

import { BOARD_SCHEMA_VERSION, parseLayer } from "../lib/board/model";
import { getRichTextJson } from "../lib/board/rich-text/document";
import { positionMigrationLayerId, validatePositionMigrationRoot } from "../lib/board/rich-text/position-migrations";
import { FRAME_ORDER_ROOT, FRAME_ROOT, MAX_FRAMES, parseFrame } from "../lib/board/frames";
import { LayerType } from "../types/board-canvas";

import { CollaborationRejection } from "./types";
import type { CollaborationLimits } from "./types";

export function initializeDocument(document: Y.Doc): void {
  document.getMap("meta").set("schemaVersion", BOARD_SCHEMA_VERSION);
  document.getMap("layers");
  document.getArray("layerIds");
}

function validateShape(document: Y.Doc, limits: CollaborationLimits, version: 1 | 2): Uint8Array {
  const state = Y.encodeStateAsUpdate(document);
  if (state.byteLength > limits.maxDocumentBytes) {
    throw new CollaborationRejection("Board storage limit reached");
  }
  const meta = document.getMap("meta");
  const layers = document.getMap("layers");
  const layerIds = document.getArray<string>("layerIds").toArray();
  if (meta.get("schemaVersion") !== version) {
    throw new CollaborationRejection("Unsupported board schema");
  }
  if (layers.size > limits.maxLayers || layerIds.length > 3 * limits.maxLayers) {
    throw new CollaborationRejection("Board object limit reached");
  }
  // Concurrent delete/insert reorders may leave duplicate or deleted references.
  // Readers normalize these; rejecting them would reject valid CRDT merges.
  if (layerIds.some((id) => typeof id !== "string" || id.length > 128)) {
    throw new CollaborationRejection("Invalid layer order");
  }
  for (const [id, layer] of layers) {
    if (id.length > 128 || !(layer instanceof Y.Map)) {
      throw new CollaborationRejection("Invalid board object");
    }
    if (["__proto__", "prototype", "constructor"].some((key) => layer.has(key)) || !parseLayer(layer.toJSON())) {
      throw new CollaborationRejection("Invalid board object");
    }
    if (version === 2 && (layer.get("type") === LayerType.Text || layer.get("type") === LayerType.Sticker)) {
      if (layer.has("value") || !document.share.has(`text:${id}`)) {
        throw new CollaborationRejection("Rich text fragment is required");
      }
    }
  }
  if (version === 2) {
    validateFrames(document);
    let fragments = 0;
    let migrationRecords = 0;
    let migrationTransfers = 0;
    let migrationCausalEntries = 0;
    for (const name of document.share.keys()) {
      if (["meta", "layers", "layerIds", FRAME_ROOT, FRAME_ORDER_ROOT].includes(name)) continue;
      if (positionMigrationLayerId(name)) {
        try {
          const counts = validatePositionMigrationRoot(document, name);
          migrationRecords += counts.records;
          migrationTransfers += counts.transfers;
          migrationCausalEntries += counts.causalEntries;
          if (migrationRecords > 5_000 || migrationTransfers > 50_000 || migrationCausalEntries > 50_000) throw new Error("Position metadata limit reached");
        } catch { throw new CollaborationRejection("Invalid text position metadata"); }
        continue;
      }
      const match = /^text:([a-zA-Z0-9_-]{1,128})$/.exec(name);
      if (!match || ++fragments > limits.maxLayers * 2) {
        throw new CollaborationRejection("Unsupported board content");
      }
      const layer = layers.get(match[1]);
      if (layer instanceof Y.Map && layer.get("type") !== LayerType.Text && layer.get("type") !== LayerType.Sticker) {
        throw new CollaborationRejection("Text fragment belongs to a non-text object");
      }
      try { getRichTextJson(document, match[1]); } catch {
        throw new CollaborationRejection("Invalid rich text");
      }
    }
  }
  return state;
}

function validateFrames(document: Y.Doc): void {
  const frames = document.getMap<Y.Map<unknown>>(FRAME_ROOT);
  const order = document.getArray<string>(FRAME_ORDER_ROOT).toArray();
  if (frames.size > MAX_FRAMES || order.length > MAX_FRAMES * 3 ||
      order.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    throw new CollaborationRejection("Invalid page regions");
  }
  for (const [id, frame] of frames) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !(frame instanceof Y.Map) ||
        ["__proto__", "prototype", "constructor"].some((key) => frame.has(key)) || !parseFrame(frame.toJSON())) {
      throw new CollaborationRejection("Invalid page region");
    }
  }
}

export function validateLegacyDocument(document: Y.Doc, limits: CollaborationLimits): Uint8Array {
  return validateShape(document, limits, 1);
}

export function validateDocument(document: Y.Doc, limits: CollaborationLimits): Uint8Array {
  return validateShape(document, limits, 2);
}

export function validateIncomingUpdate(
  document: Y.Doc,
  update: Uint8Array,
  limits: CollaborationLimits,
): void {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(candidate, update);
    validateDocument(candidate, limits);
    for (const name of document.share.keys()) {
      if (!positionMigrationLayerId(name)) continue;
      const next = candidate.getMap(name);
      for (const [key, record] of document.getMap(name)) {
        if (!next.has(key) || !isDeepStrictEqual(record, next.get(key))) {
          throw new CollaborationRejection("Text position metadata is append-only");
        }
      }
    }
  } catch (error) {
    if (error instanceof CollaborationRejection) throw error;
    throw new CollaborationRejection("Invalid board update");
  } finally {
    candidate.destroy();
  }
}
