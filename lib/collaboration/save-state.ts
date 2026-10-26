import * as Y from "yjs";

export function decodePersistedSnapshot(encoded: string): Y.Snapshot {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return Y.decodeSnapshot(bytes);
}

export function matchesPersistedSnapshot(doc: Y.Doc, persisted: Y.Snapshot | null): boolean {
  return persisted !== null && Y.equalSnapshots(Y.snapshot(doc), persisted);
}
