import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserAvatar } from "@/app/board/[boardId]/_components/user-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

vi.mock("@/components/hint", () => ({ Hint: ({ children }: { children: ReactNode }) => <>{children}</> }));

const localPath = "/avatars/avatar_3.svg";
const externalPath = "https://tracker.example/avatar.png";

function imageRequests() {
  const requested: string[] = [];
  const images: HTMLImageElement[] = [];
  vi.stubGlobal("Image", class {
    constructor() {
      const image = document.createElement("img");
      let source = "";
      Object.defineProperty(image, "src", { configurable: true, get: () => source, set: (value: string) => {
        source = value; requested.push(value);
      } });
      Object.defineProperty(image, "complete", { configurable: true, value: false });
      images.push(image);
      return image;
    }
  });
  return { requested, load: () => {
    const image = images.at(-1);
    if (!image) throw new Error("Expected a local avatar preloader");
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 48 });
    image.dispatchEvent(new Event("load"));
  } };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("avatar request privacy", () => {
  it("blocks unsafe sources before the Radix preloader can request them", () => {
    const requests = imageRequests();
    for (const src of [externalPath, "//tracker.example/avatar.png", String.raw`/\tracker.example/avatar.png`,
      "/%5ctracker.example/avatar.png", "/avatars/%61vatar_0.svg", `${localPath}?url=${externalPath}`]) {
      const view = render(<Avatar><AvatarImage src={src} alt="Участник" /><AvatarFallback>У</AvatarFallback></Avatar>);
      expect(requests.requested, src).toEqual([]);
      expect(view.container.querySelector("img")).toBeNull();
      expect(view.getByText("У")).not.toBeNull();
      view.unmount();
    }
  });

  it.each([localPath, "/api/assets/12345678-1234-4abc-8def-123456789abc"])(
    "keeps local avatar %s, classes and initials when a legacy session image becomes unsafe", (path) => {
    const requests = imageRequests();
    const view = render(<UserAvatar src={path} name="Анна" fallback="А" borderColor="red" />);
    expect(requests.requested).toEqual([path]);
    expect(view.getByText("А")).not.toBeNull();
    act(requests.load);
    const image = view.getByAltText("Анна");
    expect(image.getAttribute("src")).toBe(path);
    expect(image.className).toContain("object-cover");
    expect(view.container.querySelector('[data-slot="avatar"]')?.getAttribute("style")).toContain("border-color: red");

    view.rerender(<UserAvatar src={externalPath} name="Анна" fallback="А" borderColor="red" />);
    expect(requests.requested).toEqual([path]);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.getByText("А")).not.toBeNull();
  });

  it("does not forward an external srcSet even with an allowed local src", () => {
    const requests = imageRequests();
    const view = render(<Avatar><AvatarImage src={localPath} srcSet={`${externalPath} 2x`} alt="Участник" />
      <AvatarFallback>У</AvatarFallback></Avatar>);
    act(requests.load);
    expect(requests.requested).toEqual([localPath]);
    expect(view.getByAltText("Участник").getAttribute("src")).toBe(localPath);
    expect(view.getByAltText("Участник").getAttribute("srcset")).toBeNull();
  });

  it("prevents asChild from replacing the allowed source with a child image", () => {
    const requests = imageRequests();
    const view = render(<Avatar><AvatarImage src={localPath} asChild>
      {/* eslint-disable-next-line @next/next/no-img-element -- Exercise an untrusted child image override. */}
      <img src={externalPath} srcSet={`${externalPath} 2x`} alt="Обход" />
    </AvatarImage><AvatarFallback>У</AvatarFallback></Avatar>);
    act(requests.load);
    expect(requests.requested).toEqual([localPath]);
    const image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(localPath);
    expect(image?.getAttribute("srcset")).toBeNull();
    expect(view.queryByAltText("Обход")).toBeNull();
  });
});
