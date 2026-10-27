export const BOARD_FONTS = ["Noto Sans", "Noto Serif", "Noto Sans Mono"] as const;
export type BoardFont = typeof BOARD_FONTS[number];

/** Local font families are shared by the editor and the isolated PDF renderer. */
export function resolveBoardFont(value?: string): BoardFont {
  switch (value) {
    case "Noto Serif":
    case "Georgia":
    case "Times New Roman":
    case "serif":
      return "Noto Serif";
    case "Noto Sans Mono":
    case "Courier New":
    case "monospace":
    case "ui-monospace":
      return "Noto Sans Mono";
    default:
      return "Noto Sans";
  }
}
