import * as Y from "yjs";

import { parseLayer } from "../lib/board/model";

import { CollaborationRejection } from "./types";
import type { CollaborationLimits } from "./types";

export function initializeDocument(document: Y.Doc): void {
  document.getMap("meta").set("schemaVersion", 1);
  document.getMap("layers");
  document.getArray("layerIds");
}

export function validateDocument(document: Y.Doc, limits: CollaborationLimits): Uint8Array {
  const meta = document.getMap("meta");
  const layers = document.getMap("layers");
  const layerIds = document.getArray<string>("layerIds").toArray();
  if (meta.get("schemaVersion") !== 1) {
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
    if (id.length > 128 || !(layer instanceof Y.Map) || !parseLayer(layer.toJSON())) {
      throw new CollaborationRejection("Invalid board object");
    }
  }
  const state = Y.encodeStateAsUpdate(document);
  if (state.byteLength > limits.maxDocumentBytes) {
    throw new CollaborationRejection("Board storage limit reached");
  }
  return state;
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
  } catch (error) {
    if (error instanceof CollaborationRejection) throw error;
    throw new CollaborationRejection("Invalid board update");
  } finally {
    candidate.destroy();
  }
}
