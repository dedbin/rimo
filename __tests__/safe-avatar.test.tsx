// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { safeAvatarSrc } from "@/lib/safe-avatar";
import { validatedProfile } from "@/server/auth-profile";

const assetPath = "/api/assets/12345678-1234-4abc-8def-123456789abc";
const localPaths = [...Array.from({ length: 10 }, (_value, index) => `/avatars/avatar_${index}.svg`),
  assetPath, "/api/assets/12345678-1234-4ABC-8DEF-123456789ABC"];
const unsafePaths = [
  "https://tracker.example/avatar.png", "http://tracker.example/avatar.png",
  "https://rimo.example/avatars/avatar_0.svg", "//tracker.example/avatar.png",
  String.raw`/\tracker.example/avatar.png`, String.raw`\\tracker.example/avatar.png`,
  String.raw`/avatars\avatar_0.svg`, "/%5ctracker.example/avatar.png", "/%2ftracker.example/avatar.png",
  "/%252f%252ftracker.example/avatar.png", "/avatars/%61vatar_0.svg", "/avatars/avatar_0%2esvg",
  "/avatars/../avatar_0.svg", "/avatars/avatar_10.svg", "/avatars/arbitrary.svg",
  "/avatars/avatar_0.svg?redirect=https://tracker.example", "/avatars/avatar_0.svg#fragment",
  "/avatars/avatar_0.svg/", " /avatars/avatar_0.svg", "/avatars/avatar_0.svg ",
  "\n/avatars/avatar_0.svg", "/avatars/avatar_0.svg\n", "/avatars/avatar_0.svg\r\n",
  "/avatars/avatar_0.svg\t", "/avatars/avatar_0.svg\u0000",
  `${assetPath}?redirect=https://tracker.example`, `${assetPath}#fragment`, `${assetPath}\n`,
  "/api/assets/not-a-uuid", "/api/assets/%312345678-1234-4abc-8def-123456789abc",
  "/api/auth/callback?redirect=https://tracker.example", "/_next/image?url=https://tracker.example/avatar.png",
  "data:image/svg+xml,<svg/>", "blob:https://tracker.example/id", "javascript:alert(1)", "file:///avatar.png",
];

describe("local avatar allowlist", () => {
  it("preserves only exact bundled avatar and local asset routes", () => {
    for (const value of localPaths) expect(safeAvatarSrc(value), value).toBe(value);
    for (const value of [...unsafePaths, "", null, undefined, 42, {}, []]) {
      expect(safeAvatarSrc(value), String(value)).toBeUndefined();
    }
  });

  it("uses the same allowlist for profile writes while preserving profile clearing and names", () => {
    for (const image of localPaths) expect(validatedProfile({ image })).toEqual({ image });
    for (const image of [...unsafePaths, 42, {}, []]) {
      expect(() => validatedProfile({ image }), String(image)).toThrow(APIError);
    }
    expect(validatedProfile({ image: null })).toEqual({ image: null });
    expect(validatedProfile({ image: "" })).toEqual({ image: null });
    expect(validatedProfile({ name: "  Анна  " })).toEqual({ name: "Анна" });
    expect(validatedProfile({})).toEqual({});
    expect(() => validatedProfile({ name: " " })).toThrow(APIError);
  });

  it("renders the same initials on SSR without an image or a browser origin", () => {
    expect(typeof window).toBe("undefined");
    const html = (src?: string) => renderToStaticMarkup(<Avatar>
      <AvatarImage src={src} alt="Анна" /><AvatarFallback>А</AvatarFallback>
    </Avatar>);
    const fallback = html();
    expect(fallback).toContain("А");
    expect(fallback).not.toContain("<img");
    for (const src of [...unsafePaths, ...localPaths]) expect(html(src), src).toBe(fallback);
  });
});
