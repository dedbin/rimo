import type { BoardRole } from "../../types/service";

export interface PersistedMessage {
  type: "persisted";
  revision: number;
  snapshot: string;
  savedAt: string;
}
export interface PersistenceErrorMessage {
  type: "persistence-error";
  message: string;
}

export interface AccessRoleMessage {
  type: "access-role";
  role: BoardRole;
}

export type ServerMessage = PersistedMessage | PersistenceErrorMessage | AccessRoleMessage;

const MAX_MESSAGE_LENGTH = 8 * 1024 * 1024;

export function parseServerMessage(payload: string): ServerMessage | null {
  if (payload.length > MAX_MESSAGE_LENGTH) return null;

  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null) return null;
    if (!("type" in value)) return null;

    if (value.type === "access-role") {
      return Object.keys(value).length === 2 && "role" in value &&
        (value.role === "owner" || value.role === "editor" || value.role === "viewer")
        ? { type: value.type, role: value.role } : null;
    }

    if (value.type === "persistence-error") {
      return "message" in value && typeof value.message === "string"
        ? { type: value.type, message: value.message }
        : null;
    }

    if (
      value.type !== "persisted" ||
      !("revision" in value) ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      !("snapshot" in value) ||
      typeof value.snapshot !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.snapshot) ||
      !("savedAt" in value) ||
      typeof value.savedAt !== "string" ||
      !Number.isFinite(Date.parse(value.savedAt))
    ) return null;

    return {
      type: "persisted",
      revision: value.revision as number,
      snapshot: value.snapshot,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

