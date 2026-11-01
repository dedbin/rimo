import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SaveStatus } from "@/app/board/[boardId]/_components/save-status";
import type { ConnectionState } from "@/lib/collaboration/runtime";

const mocked = vi.hoisted(() => ({
  retry: vi.fn(),
  state: { connected: false, synced: false, saved: false, error: null, revision: 0, savedAt: null,
    pending: false, writeRejection: null } as ConnectionState,
}));
vi.mock("@/lib/collaboration/react", () => ({
  useBoardRuntime: () => ({ retryConnection: mocked.retry, session: { board: { id: "fixture" } } }),
  useBoardRole: () => null,
  useConnectionState: () => mocked.state,
}));
afterEach(() => { cleanup(); mocked.retry.mockClear(); mocked.state = {
  connected: false, synced: false, saved: false, error: null, revision: 0, savedAt: null, pending: false, writeRejection: null,
}; });

describe("admission feedback", () => {
  it("explains an unavailable transport without inventing an authentication or capacity reason", () => {
    render(<SaveStatus />);
    expect(screen.getByRole("status").textContent).toContain("Сервис может быть занят или временно недоступен");
    expect(screen.getByRole("status").textContent).toContain("Повторяем подключение");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a draft-preserving explicit retry for a classified admission rejection", () => {
    mocked.state = { ...mocked.state, capacityRejection: "server-editors", error: "Места заняты" };
    render(<SaveStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Повторить подключение" }));
    expect(mocked.retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Места заняты");
  });
});
