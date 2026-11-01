import type { ReactNode } from "react";
import { vi } from "vitest";

import { BoardDocument } from "@/lib/collaboration/document";
import { emptyPresence } from "@/lib/collaboration/presence";
import type { BoardParticipant, BoardPresence } from "@/lib/collaboration/presence";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime, ConnectionState } from "@/lib/collaboration/runtime";
import type { PresentationCamera } from "@/lib/collaboration/presentation";

export function peer(id: number, camera: PresentationCamera | null = { center: { x: 200, y: 300 }, scale: 2, following: null }): BoardParticipant {
  return { connectionId: id, info: { id: String(id), name: `Участник ${id}` }, presence: { ...emptyPresence(), camera } };
}

export class PresentationRuntime {
  readonly board = new BoardDocument();
  self: BoardParticipant = { connectionId: this.board.doc.clientID, info: { id: "self", name: "Вы" }, presence: emptyPresence() };
  others: readonly BoardParticipant[] = [];
  state: ConnectionState = { connected: true, synced: true, error: null, saved: true, revision: 1, savedAt: null, pending: false, writeRejection: null };
  readonly presenceListeners = new Set<() => void>();
  readonly stateListeners = new Set<() => void>();
  readonly updatePresence = vi.fn((patch: Partial<BoardPresence>) => {
    this.self = { ...this.self, presence: { ...this.self.presence, ...patch } };
    this.presenceListeners.forEach((listener) => listener());
  });
  readonly subscribePresence = (listener: () => void): (() => void) => {
    this.presenceListeners.add(listener); return () => { this.presenceListeners.delete(listener); };
  };
  readonly subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); };
  };
  readonly getSelf = (): BoardParticipant => this.self;
  readonly getOthers = (): readonly BoardParticipant[] => this.others;
  readonly getState = (): ConnectionState => this.state;
  readonly wrapper = ({ children }: { children: ReactNode }) =>
    <BoardRuntimeContext.Provider value={this as unknown as BoardRuntime}>{children}</BoardRuntimeContext.Provider>;

  setOthers(others: readonly BoardParticipant[]): void {
    this.others = others; this.presenceListeners.forEach((listener) => listener());
  }

  setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch }; this.stateListeners.forEach((listener) => listener());
  }
}
