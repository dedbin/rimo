import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Image } from "@/app/board/[boardId]/_components/image";
import { LayerType } from "@/types/board-canvas";

afterEach(cleanup);

it("starts loading a hidden canvas image without waiting for visibility, then reveals it after decode", async () => {
  const { container } = render(<svg><Image id="image" alt="Условие" onPointerDown={() => {}} layer={{
    type: LayerType.Image, x: 0, y: 0, width: 128, height: 64,
    src: "/api/assets/11111111-1111-4111-8111-111111111111",
  }} /></svg>);
  const image = container.querySelector("img")!;
  expect(image.getAttribute("loading")).toBe("eager");
  expect(image.style.display).toBe("none");
  // Lazy loading cannot start while display:none; canvas already culls distant layers.
  Object.defineProperty(image, "complete", { value: true, configurable: true });
  await act(async () => { fireEvent.load(image); });
  expect(image.style.display).toBe("block");
  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
});
