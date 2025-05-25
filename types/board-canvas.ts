export type Color = {
    r: number;
    g: number;
    b: number;
    a?: number;
}

export type Camera = {
    x: number;
    y: number;
    scale: number;
}

export type Point = {
    x: number;
    y: number;
}

export type XYWH = {
    x: number;
    y: number;
    width: number;
    height: number;
}

export enum side {
    top = 1,
    bottom = 2,
    left = 4,
    right = 8,
}

export enum LayerType {
    Rectangle,
    Ellipse,
    Text,
    Path,
    Sticker,
    Image
}

export type RectangleLayer = {
    type: LayerType.Rectangle;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: Color;
    stroke?: Color;
    strokeWidth?: number;
    value?: string;
}

export type PathLayer = {
    type: LayerType.Path;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: Color;
    points: number[][];
    value?: string;
    size?: number;
}

export type StickerLayer = {
    type: LayerType.Sticker;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: Color;
    value?: string;
}

export type TextLayer = {
    type: LayerType.Text;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: Color;
    stroke?: Color;
    strokeWidth?: number;
    value?: string;
    font?: string; // TODO give user ability to select font and size
}

export type EllipseLayer = {
    type: LayerType.Ellipse;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: Color;
    stroke?: Color;
    strokeWidth?: number;
    value?: string;
}

export type ImageLayer = {
    type: LayerType.Image;
    x: number;
    y: number;
    width: number;
    height: number;
    src: string;
    value?: string;
    fill?: Color;
}

export type Layer = RectangleLayer | EllipseLayer | TextLayer | PathLayer | StickerLayer | ImageLayer

export enum BoardCanvasMode {
    None,
    Pressing,
    SelectionNet,
    Translating,
    Inserting,
    Resizing,
    Pencil
}

export type BoardCanvasState =
  | { mode: BoardCanvasMode.None }

  | { mode: BoardCanvasMode.Pressing, origin: Point }

  | { mode: BoardCanvasMode.SelectionNet, origin: Point, current?: Point }

  | { mode: BoardCanvasMode.Translating, current: Point }

  | { mode: BoardCanvasMode.Inserting, layerType: LayerType.Ellipse | LayerType.Rectangle | LayerType.Sticker | LayerType.Text | LayerType.Image }

  | { mode: BoardCanvasMode.Resizing, initial: XYWH, corner: side }

  | { mode: BoardCanvasMode.Pencil };
