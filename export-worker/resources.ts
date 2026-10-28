import { readFile } from "node:fs/promises";
import path from "node:path";

let resources: Promise<string> | undefined;

interface LocalFont { readonly packageName: string; readonly family: string; readonly styles: readonly string[] }
const FONTS: readonly LocalFont[] = [
  { packageName: "noto-sans", family: "Noto Sans", styles: ["normal", "italic"] },
  { packageName: "noto-serif", family: "Noto Serif", styles: ["normal", "italic"] },
  { packageName: "noto-sans-mono", family: "Noto Sans Mono", styles: ["normal"] },
];

async function fontFace(font: LocalFont, subset: string, weight: number, style: string): Promise<string> {
  const filename = path.resolve(`node_modules/@fontsource/${font.packageName}/files`, `${font.packageName}-${subset}-${weight}-${style}.woff2`);
  const data = await readFile(filename);
  return `@font-face{font-family:'${font.family}';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data.toString("base64")}) format('woff2');${subset === "cyrillic" ? "unicode-range:U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116;" : "unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;"}}`;
}

async function loadResources(): Promise<string> {
  const fonts = await Promise.all(FONTS.flatMap((font) => ["latin", "cyrillic"].flatMap((subset) => [400, 700].flatMap((weight) =>
    font.styles.map((style) => fontFace(font, subset, weight, style)),
  ))));
  const katexDirectory = path.resolve("node_modules/katex/dist");
  const css = await readFile(path.join(katexDirectory, "katex.min.css"), "utf8");
  const sources = [...css.matchAll(/src:([^;]+);/g)];
  let embedded = css;
  for (const source of sources) {
    const filename = /url\((?:["'])?(fonts\/[a-zA-Z0-9_-]+\.woff2)(?:["'])?\)/.exec(source[1])?.[1];
    if (!filename) throw new Error("Unsupported local KaTeX font source");
    const bytes = await readFile(path.join(katexDirectory, filename));
    embedded = embedded.replace(source[0], `src:url(data:font/woff2;base64,${bytes.toString("base64")}) format('woff2');`);
  }
  if (/url\((?!data:)/.test(embedded)) throw new Error("External font sources are not allowed");
  return `${fonts.join("")}\n${embedded}`;
}

export async function localPdfResources(): Promise<string> {
  resources ??= loadResources().catch((error: unknown) => { resources = undefined; throw error; });
  return resources;
}
