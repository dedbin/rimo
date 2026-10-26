import { fireEvent, render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlainTextContent } from "@/app/board/[boardId]/_components/plain-text-content";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";

afterEach(cleanup);

describe("plain text activation", () => {
  it("leaves editing on an outside pointerdown even when canvas prevents native blur", () => {
    const runtime = { board: { canEdit: true, update: vi.fn() } } as unknown as BoardRuntime;
    const result = render(<BoardRuntimeContext.Provider value={runtime}>
      <PlainTextContent id="text" value="" /><svg aria-label="canvas" onPointerDown={(event) => event.preventDefault()} />
    </BoardRuntimeContext.Provider>);
    const text = result.container.querySelector('[data-placeholder="Текст"]')!;
    fireEvent.doubleClick(text);
    expect(text.getAttribute("role")).toBe("textbox");
    fireEvent.pointerDown(result.getByLabelText("canvas"));
    expect(text.getAttribute("role")).toBeNull();
    expect(text.getAttribute("contenteditable")).toBe("false");
    expect((text as HTMLElement).style.userSelect).toBe("none");
  });
});
