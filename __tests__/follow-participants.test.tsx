import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardParticipants } from "@/app/board/[boardId]/_components/participants";

import { peer, PresentationRuntime } from "./presentation-runtime";

let runtime: PresentationRuntime;
beforeEach(() => { runtime = new PresentationRuntime(); runtime.others = [peer(2), peer(3), peer(4)]; });
afterEach(() => { cleanup(); runtime.board.destroy(); });

describe("participant following controls", () => {
  it("offers explicit follow and stop controls while keeping the self avatar noninteractive", () => {
    const onFollow = vi.fn();
    const { rerender } = render(<BoardParticipants onFollow={onFollow} />, { wrapper: runtime.wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Следовать за Участник 2" }));
    expect(onFollow).toHaveBeenCalledWith(2);
    expect(screen.queryByRole("button", { name: "Следовать за Вы" })).toBeNull();
    rerender(<BoardParticipants followingId={2} onFollow={onFollow} />);
    expect(screen.getByRole("button", { name: "Не следовать за Участник 2" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").getAttribute("data-following-id")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Прекратить следование" }));
    expect(onFollow).toHaveBeenLastCalledWith(2);
  });

  it("makes participants behind the overflow control available to the keyboard", () => {
    const onFollow = vi.fn();
    render(<BoardParticipants onFollow={onFollow} />, { wrapper: runtime.wrapper });
    fireEvent.keyDown(screen.getByRole("button", { name: "Другие участники" }), { key: "Enter", code: "Enter" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Следовать за Участник 4" }));
    expect(onFollow).toHaveBeenCalledWith(4);
  });
});
