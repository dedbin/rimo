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
  Sticker,
  Path,
  Image,
  LinkPreview = "linkPreview",
  Line = 6,
  Graph = 7,
}

export type GraphExpression = {
    formula: string;
    color: string;
    visible: boolean;
    order: number;
};

export type GraphViewport = {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
};

export type GraphSettings = {
    expressions: Record<string, GraphExpression>;
    viewport: GraphViewport;
    showGrid: boolean;
};

export type GraphLayer = XYWH & {
    type: LayerType.Graph;
    graph: GraphSettings;
    fill?: Color;
    value?: string;
};

export type LineKind = "segment" | "line";
export type LineStrokeStyle = "solid" | "dashed";

export type LineLayer = XYWH & {
    type: LayerType.Line;
    fill: Color;
    strokeWidth: number;
    start: Point;
    end: Point;
    lineKind: LineKind;
    strokeStyle?: LineStrokeStyle;
    startArrow: boolean;
    endArrow: boolean;
    value?: string;
};

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
    fontFamily?: string;
    fontSize: number;
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
    fontFamily?: string;
    fontSize: number;
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

export type LinkPreviewLayer = {
  type: LayerType.LinkPreview;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  fill?: Color;
};

export type Layer = RectangleLayer | EllipseLayer | TextLayer | PathLayer | StickerLayer | ImageLayer | LinkPreviewLayer | LineLayer | GraphLayer

export enum BoardCanvasMode {
    None,
    Pressing,
    SelectionNet,
    Translating,
    Inserting,
    Resizing,
    Pencil,
    Panning,
    Eraser,
    EditingLine,
    Laser,
}

type BaseCanvasState = { previousState?: BoardCanvasState  };

export type BoardCanvasState =
  | ({ mode: BoardCanvasMode.None } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Pressing; origin: Point } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.SelectionNet; origin: Point; current?: Point } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Translating; current: Point } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Inserting; layerType: LayerType.Ellipse | LayerType.Rectangle | LayerType.Sticker | LayerType.Text | LayerType.Image | LayerType.LinkPreview | LayerType.Line | LayerType.Graph; lineKind?: LineKind; strokeStyle?: LineStrokeStyle } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Resizing; initial: XYWH; corner: side } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Pencil } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Panning; origin: Point; current: Point; screenX: number; screenY: number } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Eraser } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.Laser } & BaseCanvasState)
  | ({ mode: BoardCanvasMode.EditingLine; id: string; endpoint: "start" | "end" } & BaseCanvasState)



