import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PenTool } from "@/app/board/[boardId]/_components/pen-tool";
import { usePenPreferences } from "@/app/board/[boardId]/_hooks/use-pen-preferences";

function PersonalTool() {
  const [active, setActive] = useState(false);
  const pen = usePenPreferences("teacher");
  return <PenTool active={active} color={pen.color} size={pen.size} onActivate={() => setActive(true)}
    onColorChange={pen.setColor} onSizeChange={pen.setSize} />;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function settings(): HTMLElement {
  fireEvent.keyDown(screen.getByRole("button", { name: "Настройки маркера" }), { key: "Enter" });
  return screen.getByRole("menu", { name: "Настройки маркера" });
}

describe("marker controls before the first stroke", () => {
  it("activates the marker directly without opening a menu", () => {
    const onActivate = vi.fn();
    render(<PenTool active={false} color={{ r: 0, g: 0, b: 0 }} size={16}
      onActivate={onActivate} onColorChange={vi.fn()} onSizeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Маркер" }));
    expect(onActivate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lets users choose color and width before drawing, keeping the choices across activation and remount", () => {
    const first = render(<PersonalTool />);
    const menu = settings();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Цвет маркера: Синий" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс" }));
    expect(screen.getByRole("menuitemradio", { name: "Цвет маркера: Синий" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Маркер" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Маркер" }));
    expect(screen.queryByRole("menu")).toBeNull();
    first.unmount();
    render(<PersonalTool />);
    settings();
    expect(screen.getByRole("menuitemradio", { name: "Цвет маркера: Синий" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс" }).getAttribute("aria-checked")).toBe("true");
  });
});
