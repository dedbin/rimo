import { DEFAULT_LIMITS } from "./types";
import type { CollaborationLimits } from "./types";

export type CollaborationAdmissionLimits = Readonly<Pick<CollaborationLimits,
  "maxConnections" | "maxRoomConnections" | "maxEditors" | "maxOpenDocuments"
>>;

// Guard against configuration mistakes; this ceiling is not a capacity claim.
const MAX_ADMISSION_LIMIT = 50;

type AdmissionEnvironment = Readonly<Record<string, string | undefined>>;

function limit(environment: AdmissionEnvironment, name: string, fallback: number): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_ADMISSION_LIMIT}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_ADMISSION_LIMIT) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_ADMISSION_LIMIT}`);
  }
  return parsed;
}

export function getCollaborationAdmissionLimits(
  environment: AdmissionEnvironment = process.env,
): CollaborationAdmissionLimits {
  const limits = {
    maxConnections: limit(environment, "COLLABORATION_MAX_CONNECTIONS", DEFAULT_LIMITS.maxConnections),
    maxRoomConnections: limit(environment, "COLLABORATION_MAX_ROOM_CONNECTIONS", DEFAULT_LIMITS.maxRoomConnections),
    maxEditors: limit(environment, "COLLABORATION_MAX_EDITORS", DEFAULT_LIMITS.maxEditors),
    maxOpenDocuments: limit(environment, "COLLABORATION_MAX_OPEN_DOCUMENTS", DEFAULT_LIMITS.maxOpenDocuments),
  };
  for (const [name, value] of [
    ["COLLABORATION_MAX_ROOM_CONNECTIONS", limits.maxRoomConnections],
    ["COLLABORATION_MAX_EDITORS", limits.maxEditors],
    ["COLLABORATION_MAX_OPEN_DOCUMENTS", limits.maxOpenDocuments],
  ] as const) {
    if (value > limits.maxConnections) {
      throw new Error(`${name} must not exceed COLLABORATION_MAX_CONNECTIONS`);
    }
  }
  return Object.freeze(limits);
}
