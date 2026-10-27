import type { Connection } from "@hocuspocus/server";

export type BoardRole = "owner" | "editor" | "viewer";

export interface CollaborationPrincipal {
  boardId: string;
  userId: string;
  sessionId: string;
  name: string;
  image?: string;
  role: BoardRole;
}

export interface CollaborationContext extends CollaborationPrincipal {
  reservationId: string;
}

export interface StoredDocument {
  state: Uint8Array;
  revision: number;
  savedAt: Date;
}

export interface SnapshotRepository {
  load(boardId: string): Promise<StoredDocument | null>;
  save(boardId: string, state: Uint8Array): Promise<Omit<StoredDocument, "state">>;
  health(): Promise<boolean>;
}

export interface CollaborationDependencies {
  repository: SnapshotRepository;
  authenticate(headers: Headers, boardId: string): Promise<CollaborationPrincipal | null>;
  revalidate(principal: CollaborationPrincipal): Promise<BoardRole | null>;
}

export interface ConnectionReservation {
  context: CollaborationContext;
  socketId: string;
  checkedAt: number;
  connection?: Connection<CollaborationContext>;
}

export interface CollaborationLimits {
  maxConnections: number;
  maxRoomConnections: number;
  maxEditors: number;
  maxOpenDocuments: number;
  maxPayloadBytes: number;
  maxDocumentBytes: number;
  maxLayers: number;
  maxMessagesPerSecond: number;
  maxBytesPerSecond: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxTotalQueuedBytes: number;
  aclRefreshMs: number;
  aclCheckTimeoutMs: number;
  persistenceDebounceMs: number;
  persistenceMaxDebounceMs: number;
}

export const DEFAULT_LIMITS: Readonly<CollaborationLimits> = Object.freeze({
  maxConnections: 50,
  maxRoomConnections: 10,
  maxEditors: 10,
  maxOpenDocuments: 10,
  maxPayloadBytes: 6 * 1024 * 1024,
  maxDocumentBytes: 5 * 1024 * 1024,
  maxLayers: 10_000,
  maxMessagesPerSecond: 120,
  maxBytesPerSecond: 2 * 1024 * 1024,
  maxQueuedMessages: 32,
  maxQueuedBytes: 6 * 1024 * 1024,
  maxTotalQueuedBytes: 32 * 1024 * 1024,
  aclRefreshMs: 5_000,
  aclCheckTimeoutMs: 3_000,
  persistenceDebounceMs: 500,
  persistenceMaxDebounceMs: 2_000,
});

export class CollaborationRejection extends Error {
  readonly code = 1008;
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export class DocumentRemovedError extends Error {
  constructor() {
    super("Board no longer exists");
  }
}
