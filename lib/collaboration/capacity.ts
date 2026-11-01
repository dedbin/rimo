export type CapacityRejection = "server-connections" | "board-connections" | "server-editors" | "open-boards";

const REASONS: Readonly<Record<string, CapacityRejection>> = Object.freeze({
  "Server connection limit reached": "server-connections",
  "Board connection limit reached": "board-connections",
  "Server editor limit reached": "server-editors",
  "Server open board limit reached": "open-boards",
});

export const CAPACITY_MESSAGES: Readonly<Record<CapacityRejection, string>> = Object.freeze({
  "server-connections": "Сервис занят: достигнут предел одновременных подключений. Попробуйте подключиться позже.",
  "board-connections": "На этой доске уже максимальное число участников. Попробуйте подключиться позже.",
  "server-editors": "Все места для одновременного редактирования заняты. Попробуйте подключиться позже.",
  "open-boards": "Сейчас открыто максимальное число досок. Попробуйте подключиться позже.",
});

export function parseCapacityRejection(reason: string): CapacityRejection | null {
  return Object.hasOwn(REASONS, reason) ? REASONS[reason] : null;
}
