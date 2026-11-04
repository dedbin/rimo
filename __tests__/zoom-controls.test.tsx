import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZoomControls } from "@/app/board/[boardId]/_components/zoom-controls";
import translations from "@/locales/ru/translation.json";

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({ t: (key: string) => translations.zoomControls[key.split(".")[1] as keyof typeof translations.zoomControls] }),
}));
vi.mock("@/components/hint", () => ({ Hint: ({ label, children }: { label: string; children: ReactNode }) =>
  <span data-hint={label}>{children}</span> }));

afterEach(cleanup);

function Controls({ onFit }: { onFit: () => void }) {
  const [enabled, setEnabled] = useState(true);
  return <ZoomControls scale={1.25} onFitToScreen={onFit} autoPanEnabled={enabled}
    onToggleAutoPan={() => setEnabled((previous) => !previous)} />;
}

describe("edge auto-pan switch beside zoom", () => {
  it("announces its pressed state and switches its state and hint without fitting the board", () => {
    const onFit = vi.fn();
    render(<Controls onFit={onFit} />);
    const toggle = screen.getByRole("button", { name: "Автопрокрутка у края" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.closest("[data-hint]")?.getAttribute("data-hint")).toBe("Автопрокрутка у края включена");
    expect(screen.getByText("125%")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.closest("[data-hint]")?.getAttribute("data-hint")).toBe("Автопрокрутка у края выключена");
    expect(onFit).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const fit = document.querySelector('[data-hint="Уместить все"] button');
    expect(fit).not.toBeNull();
    fireEvent.click(fit!);
    expect(onFit).toHaveBeenCalledTimes(1);
  });
});
