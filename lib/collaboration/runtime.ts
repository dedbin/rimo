import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { BoardRole, BoardSession } from "@/types/service";
import { BOARD_SCHEMA_VERSION } from "@/lib/board/model";
import { BoardDocument } from "./document";
import { configureOfflineSync } from "./offline-sync";
import { BoardParticipant, BoardPresence, emptyPresence, parseParticipant } from "./presence";
import { parseServerMessage } from "./protocol";
import { decodePersistedSnapshot, matchesPersistedSnapshot } from "./save-state";

export type WriteRejection = "storage-limit" | "object-limit";

const ACCESS_DENIED_MESSAGE = "Доступ к доске прекращён. Обновите страницу или откройте действующее приглашение.";
const WRITE_REJECTION_MESSAGES: Record<WriteRejection, string> = {
  "storage-limit": "Достигнут предел размера доски. Последние изменения не сохранены.",
  "object-limit": "Достигнут предел количества объектов. Последние изменения не сохранены.",
};

function rejectedWrite(reason: string): WriteRejection | null {
  if (reason === "Board storage limit reached") return "storage-limit";
  if (reason === "Board object limit reached") return "object-limit";
  return null;
}

export interface ConnectionState {
  connected: boolean;
  synced: boolean;
  saved: boolean;
  error: string | null;
  revision: number;
  savedAt: string | null;
  pending: boolean;
  writeRejection: WriteRejection | null;
}

export class BoardRuntime {
  readonly board: BoardDocument;
  readonly session: BoardSession;
  readonly provider: HocuspocusProvider;
  private state: ConnectionState = {
    connected: false, synced: false, saved: false, error: null, revision: 0, savedAt: null, pending: false, writeRejection: null,
  };
  private readonly stateListeners = new Set<() => void>();
  private readonly presenceListeners = new Set<() => void>();
  private committedSnapshot: Y.Snapshot | null = null;
  private self: BoardParticipant;
  private others: readonly BoardParticipant[] = [];
  private destroyed = false;
  private accessDenied = false;
  private effectiveRole: BoardRole | null = null;

  constructor(session: BoardSession) {
    this.session = session;
    this.board = new BoardDocument(new Y.Doc(), false);
    this.self = { connectionId: this.board.doc.clientID, info: {
      id: session.user.id, name: session.user.name,
      ...(session.user.image ? { picture: session.user.image } : {}),
    }, presence: emptyPresence() };
    this.board.doc.on("update", this.handleDocumentUpdate);
    this.provider = new HocuspocusProvider({
      url: session.connection.url, name: session.board.id,
      token: session.connection.token, document: this.board.doc,
      onStatus: ({ status }) => {
        if (status !== "connected") this.effectiveRole = null;
        this.updateState({ connected: status === "connected", ...(status !== "connected" ? { synced: false } : {}) });
      },
      onSynced: ({ state }) => {
        if (this.accessDenied || this.state.writeRejection) return;
        const schema = this.board.doc.getMap("meta").get("schemaVersion");
        if (state && schema !== BOARD_SCHEMA_VERSION) {
          this.updateState({ synced: false, error: "Версия документа не поддерживается. Обновите страницу." });
          return;
        }
        this.updateState({ synced: state });
        if (state) this.provider.sendStateless(JSON.stringify({ type: "persistence-status" }));
      },
      onAuthenticationFailed: () => {
        this.accessDenied = true;
        this.effectiveRole = null;
        this.updateState({ connected: false, synced: false });
      },
      onClose: ({ event }) => {
        this.effectiveRole = null;
        if (event.code === 1008 || /access revoked|read.only|board removed|permission denied/i.test(event.reason)) this.accessDenied = true;
        const rejection = rejectedWrite(event.reason);
        if (!this.accessDenied && rejection && !this.state.writeRejection) {
          this.updateState({ connected: false, synced: false, writeRejection: rejection });
          // This provider owns its socket. Stop reconnect/replay without destroying the local draft.
          this.provider.disconnect();
          return;
        }
        this.updateState({ connected: false, synced: false });
      },
      onDisconnect: () => {
        this.effectiveRole = null;
        this.updateState({ connected: false, synced: false });
      },
      onStateless: ({ payload }) => this.handleServerMessage(payload),
    });
    configureOfflineSync(this.provider.configuration.websocketProvider);
    this.provider.awareness?.on("update", this.handleAwarenessUpdate);
    this.provider.awareness?.setLocalState({ user: this.self.info, presence: this.self.presence });
  }

  getState = (): ConnectionState => this.state;
  getRole = (): BoardRole | null => this.effectiveRole;
  getSelf = (): BoardParticipant => this.self;
  getOthers = (): readonly BoardParticipant[] => this.others;
  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };
  subscribePresence = (listener: () => void): (() => void) => {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  };

  updatePresence = (patch: Partial<BoardPresence>, broadcast = true): void => {
    if (this.destroyed) return;
    this.self = { ...this.self, presence: { ...this.self.presence, ...patch } };
    if (broadcast && !this.accessDenied && !this.state.writeRejection) this.provider.awareness?.setLocalStateField("presence", this.self.presence);
    for (const listener of this.presenceListeners) listener();
  };

  private refreshOthers(): void {
    const states = this.provider?.awareness?.getStates();
    if (!states) return;
    const others: BoardParticipant[] = [];
    for (const [id, value] of states) {
      if (id === this.board.doc.clientID) continue;
      const participant = parseParticipant(id, value);
      if (participant) others.push(participant);
    }
    this.others = others;
    for (const listener of this.presenceListeners) listener();
  }

  private handleAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    if ([...added, ...updated, ...removed].some((id) => id !== this.board.doc.clientID)) this.refreshOthers();
  };

  private updateState(patch: Partial<ConnectionState>): void {
    if (this.destroyed) return;
    const writeRejection = this.accessDenied ? null : this.state.writeRejection ?? patch.writeRejection ?? null;
    const saved = !this.accessDenied && !writeRejection && matchesPersistedSnapshot(this.board.doc, this.committedSnapshot);
    this.state = { ...this.state, ...patch, writeRejection, saved,
      pending: writeRejection ? true : saved ? false : patch.pending ?? this.state.pending,
      ...(this.accessDenied || writeRejection ? { connected: false, synced: false,
        error: this.accessDenied ? ACCESS_DENIED_MESSAGE : WRITE_REJECTION_MESSAGES[writeRejection!] } : {}) };
    this.board.setWritable(this.state.connected && this.state.synced && !this.state.error && !this.accessDenied &&
      !writeRejection && this.effectiveRole !== null && this.effectiveRole !== "viewer");
    for (const listener of this.stateListeners) listener();
  }

  private handleDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    this.updateState(this.board.isLocalOrigin(origin) ? { pending: true } : {});
  };

  private handleServerMessage(payload: string): void {
    if (this.destroyed || this.accessDenied || this.state.writeRejection) return;
    const message = parseServerMessage(payload);
    if (!message) return;
    if (message.type === "access-role") {
      if (!this.state.connected) return;
      this.effectiveRole = message.role;
      this.updateState({});
      return;
    }
    if (message.type === "persistence-error") {
      this.updateState({ error: message.message });
      return;
    }
    if (message.revision < this.state.revision) return;
    try {
      this.committedSnapshot = decodePersistedSnapshot(message.snapshot);
      this.updateState({ revision: message.revision, savedAt: message.savedAt,
        ...(!this.accessDenied ? { error: null } : {}) });
    } catch {
      this.updateState({ error: "Не удалось проверить подтверждение сохранения" });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.provider.awareness?.off("update", this.handleAwarenessUpdate);
    this.provider.destroy();
    this.board.doc.off("update", this.handleDocumentUpdate);
    this.board.destroy();
    this.stateListeners.clear();
    this.presenceListeners.clear();
  }
}
