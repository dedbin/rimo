import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyPresence } from "@/lib/collaboration/presence";
import { CursorsPresence } from "@/app/board/[boardId]/_components/cursors-presence";

vi.mock("@/lib/collaboration/react", () => ({ useOthers: () => [{
  connectionId: 1, info: { id: "peer", name: "Ученик" },
  presence: { ...emptyPresence(), cursor: { x: 450, y: 400 }, pencilDraft: [[450, 400, 0.5], [460, 410, 0.5]] },
}] }));
afterEach(cleanup);

it("keeps remote cursors and pencil previews outside the canvas hit-testing surface", () => {
  const { container } = render(<svg><CursorsPresence /></svg>);
  const cursor = container.querySelector("foreignObject");
  const draft = container.querySelector("path");
  expect(cursor).not.toBeNull();
  expect(draft).not.toBeNull();
  expect(cursor?.closest('[pointer-events="none"]')).not.toBeNull();
  expect(draft?.closest('[pointer-events="none"]')).not.toBeNull();
});
