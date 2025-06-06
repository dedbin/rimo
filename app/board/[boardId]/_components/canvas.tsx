"use client";


import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { LiveMap, LiveObject } from "@liveblocks/client";
import {
  useCanRedo,
  useCanUndo,
  useHistory,
  useMutation,
  useOthersMapped,
  useSelf,
  useStorage,
  useUpdateMyPresence,
} from "@liveblocks/react/suspense";
import { nanoid } from "nanoid";
import { toast } from "sonner";

import { useDeleteLayers } from "@/hooks/use-delete-layers";
import { useTranslation } from "@/hooks/use-translation";
import {
  connectionIdToColor,
  doesPointIntersectPath,
  getLayerBounds,
  isPointNearBoundingBox,
  makePathLayer,
  measureText,
  pickLayersInBox,
  pointerEventToCanvasPoint,
  resizeBounds,
  rgbToCss,
} from "@/lib/utils";
import {
  BoardCanvasMode,
  BoardCanvasState,
  Camera,
  Color,
  EllipseLayer,
  ImageLayer,
  Layer,
  LayerType,
  LinkPreviewLayer,
  PathLayer,
  Point,
  RectangleLayer,
  side,
  StickerLayer,
  TextLayer,
  XYWH,
} from "@/types/board-canvas";

import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import { CursorsPresence } from "./cursors-presence";
import { GridBackground } from "./grid-background";
import { LayerPreview } from "./layer-preview";
import { Path } from "./path";
import { SelectionBox } from "./selection-box";
import { SelectionTools } from "./selection-tools";
import { SessionTimer } from "./session-timer";


const MAX_LAYERS = 1000;
const SELECTION_THRESHOLD = 5;
const MIN_FONT_SIZE = 12;
const PADDING_X = 8;
const PADDING_Y = 4;

function isLayerClipboardData(text: string): boolean {
  if (!text.trim().startsWith("[")) return false;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 && "type" in parsed[0];
  } catch {
    return false;
  }
}


interface BoardCanvasProps {
  boardId: string;
}

export function createLayer(
  layerType: LayerType,
  position: Point,
  lastUsedColor: Color
): LiveObject<Layer> {
  switch (layerType) {
    case LayerType.Rectangle:
      return new LiveObject<RectangleLayer>({
        type: LayerType.Rectangle,
        x: position.x,
        y: position.y,
        width: 100,
        height: 100,
        fill: lastUsedColor,
      });

    case LayerType.Ellipse:
      return new LiveObject<EllipseLayer>({
        type: LayerType.Ellipse,
        x: position.x,
        y: position.y,
        width: 100,
        height: 100,
        fill: lastUsedColor,
      });

    case LayerType.Text:
      return new LiveObject<TextLayer>({
        type: LayerType.Text,
        x: position.x,
        y: position.y,
        width: 100,
        height: 100,
        value: "Text",
        fill: lastUsedColor,
      });

    case LayerType.Sticker:
      return new LiveObject<StickerLayer>({
        type: LayerType.Sticker,
        fill: lastUsedColor,
        x: position.x,
        y: position.y,
        width: 100,
        height: 100,
        value: "Text",
      });

    case LayerType.Image:
      throw new Error("Use insertImageLayer for image layers");

    default:
      throw new Error(`Unsupported layer type: ${layerType}`);
  }
}

export const BoardCanvas = ({ boardId }: BoardCanvasProps) => {
  const { t } = useTranslation();
  const self = useSelf();

  const layerIds = useStorage((root) => root.layerIds);

  const pencilDraft = useSelf((me) => me.presence.pencilDraft);

  if (!layerIds) {
    console.error("layerIds not found"); // TODO: make pretty error screen
    return null;
  }
  
  const [canvasState, setCanvasState] = useState<BoardCanvasState>({
    mode: BoardCanvasMode.None,
  });

  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [lastUsedColor, setLastUsedColor] = useState<Color>({r: 0, g: 0, b: 0,}); 
  const [lastUsedSize, setLastUsedSize] = useState<number>(16);

  const cameraRef = useRef<Camera>(camera);
  const rafRef = useRef<number | null>(null);

  const history = useHistory();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  const svgRef = useRef<SVGSVGElement | null>(null);

  const insertImageLayer = useMutation(
  ({ storage, setMyPresence }, imageUrl: string, position: Point) => {
    const liveLayers = storage.get("layers");
    const liveLayerIds = storage.get("layerIds");

    if (liveLayers.size >= MAX_LAYERS) {
      console.warn("Max layers reached");
      toast.error(t("canvas.max-layers-reached"));
      return;
    }

    const id = nanoid();
    const layer = new LiveObject<ImageLayer>({
      type: LayerType.Image,
      x: position.x,
      y: position.y,
      width: 300,
      height: 300,
      src: imageUrl,
    });

    liveLayers.set(id, layer);
    liveLayerIds.push(id);

    setMyPresence({ selection: [id] }, { addToHistory: true });
    setCanvasState({ mode: BoardCanvasMode.None });
  },
  []
);

  const insertLayer = useMutation((
    { storage, setMyPresence },
    layerType: LayerType.Ellipse | LayerType.Rectangle | LayerType.Sticker | LayerType.Text | LayerType.Image | LayerType.LinkPreview,
    position: Point
  ) => {
    const liveLayers = storage.get("layers");

    if (liveLayers.size >= MAX_LAYERS) {
      console.warn("Max layers reached");
      toast.error(t("canvas.max-layers-reached"));
      return;
    }

    const liveLayerIds = storage.get("layerIds");
    const layerId = nanoid();
    const layer = createLayer(layerType, position, lastUsedColor);

    liveLayers.set(layerId, layer);
    liveLayerIds.push(layerId);

    setMyPresence({ selection: [layerId] }, { addToHistory: true });
    setCanvasState({ mode: BoardCanvasMode.None });
  }, [lastUsedColor]);

  const unselectLayer = useMutation(({ self, setMyPresence }) => {
    if (self.presence.selection.length > 0) {
      setMyPresence({ selection: [] }, { addToHistory: true });
    };
  }, [])

  const resizeLayer = useMutation(
    ({ storage, self }, point: Point) => {
      if (canvasState.mode !== BoardCanvasMode.Resizing) return;

      const initial = canvasState.initial!;
      const corner  = canvasState.corner!;
      const bounds    = resizeBounds(initial, corner, point);

      const liveLayers = storage.get("layers");
      const layer      = liveLayers.get(self.presence.selection[0]);
      if (!layer) return;

      if (layer.get("type") === LayerType.Text) {
        const text = layer.get("value")?.toString() || "";
        const minW = measureText(text, MIN_FONT_SIZE) + PADDING_X * 2;
        const minH = MIN_FONT_SIZE * 1.2 + PADDING_Y * 2;

        if (bounds.width < minW) {
          if (corner & side.left) {
            bounds.x = initial.x + initial.width - minW;
          }
          bounds.width = minW;
        }
        if (bounds.height < minH) {
          if (corner & side.top) {
            bounds.y = initial.y + initial.height - minH;
          }
          bounds.height = minH;
        }
      }

      layer.update(bounds);
    },
    [canvasState]
  );

  const updateSelectionNet = useMutation(
    ({ storage, setMyPresence }, current: Point, origin: Point) => {
      if (canvasState.mode !== BoardCanvasMode.SelectionNet) return;

      setCanvasState({ mode: BoardCanvasMode.SelectionNet, origin, current });
      
      const liveLayerIds = storage.get("layerIds");
      const layerArray = Array.from(liveLayerIds);
      const liveLayers = storage.get("layers").toImmutable();

      const ids = pickLayersInBox(
        layerArray,
        liveLayers,
        origin,
        current
      );

      setMyPresence({ selection: ids });
    },
    [layerIds, canvasState.mode]
  );

  const startMultiSelect = useCallback(
    (current: Point, origin: Point) => {
      if (Math.abs(current.x - origin.x) + Math.abs(current.y - origin.y) > SELECTION_THRESHOLD) {
        setCanvasState({
          mode: BoardCanvasMode.SelectionNet,
          origin,
          current,
        });
      }
    },
    []
  );

  const continueDrawing = useMutation(
    ({ self, setMyPresence }, point: Point, e: React.PointerEvent) => {
      if (canvasState.mode !== BoardCanvasMode.Pencil || e.buttons !== 1) {
        return;
      }

      const draft = (self.presence.pencilDraft ?? []) as [number, number, number][];
      
      const last = draft[draft.length - 1];
      const [lastX, lastY] = last ?? [NaN, NaN];

      const pressure = e.pressure ?? 0.5;
      const isSame =
        lastX === point.x &&
        lastY === point.y;

      const newDraft = isSame
        ? draft
        : [...draft, [point.x, point.y, pressure] as [number, number, number]];

      setMyPresence({
        cursor: point,
        pencilDraft: newDraft,
      });
    },
    [canvasState.mode]
  );

  const startDrawing = useMutation(
    ({ setMyPresence }, point: Point, e: React.PointerEvent) => {
      if (canvasState.mode !== BoardCanvasMode.Pencil || e.buttons !== 1) {
        return;
      }

      const pressure = e.pressure ?? 0.5;
      setMyPresence({
        pencilDraft: [[point.x, point.y, pressure] as [number, number, number]],
        penColor: lastUsedColor,
        penSize: lastUsedSize,
      });
    },
    [canvasState.mode, lastUsedColor, lastUsedSize]
  );

  const insertPath = useMutation(
    ({ storage, self, setMyPresence }) => {
      const draft = self.presence.pencilDraft as [number, number, number][] | null;
      const layers = storage.get("layers");
      const layerIds = storage.get("layerIds");

      if (layers.size >= MAX_LAYERS) {
        toast.error(t("canvas.max-layers-reached"));
        return;
      }

      if (!draft || draft.length < 2) {
        setMyPresence({ pencilDraft: null });
        console.error("Failed to insert path");

        return;
      }

      const id = nanoid();
      layers.set(id, new LiveObject(makePathLayer(draft, lastUsedColor, lastUsedSize)));
      layerIds.push(id);

      setMyPresence({ pencilDraft: null });
      setCanvasState({ mode: BoardCanvasMode.Pencil });
    },
    [lastUsedColor, lastUsedSize]
  );

  const startErasing = useMutation(
    ({ setMyPresence }, point: Point, e: React.PointerEvent) => {
      if (canvasState.mode !== BoardCanvasMode.Eraser || e.buttons !== 1) return;

      setMyPresence({ eraserDraft: [point] });
    },
    [canvasState.mode]
  );
  const continueErasing = useMutation( // TODO: add trail with delay
  ({ self, setMyPresence, storage }, point: Point, e: React.PointerEvent) => {
    if (canvasState.mode !== BoardCanvasMode.Eraser || e.buttons !== 1) return;

    history.pause();

    const draft = (self.presence.eraserDraft ?? []) as Point[];
    const last = draft[draft.length - 1];
    const isSame = last?.x === point.x && last?.y === point.y;

    const newDraft = isSame ? draft : [...draft, point];
    setMyPresence({ cursor: point, eraserDraft: newDraft });

    const layers = storage.get("layers");
    const layerIds = storage.get("layerIds");

    for (const [id, layer] of layers.entries()) {
      const type = layer.get("type");
      if (type === LayerType.Path) continue;

      const bounds = getLayerBounds(layer);
      if (!bounds) continue;

      const nearAny = newDraft.some(p => isPointNearBoundingBox(p, bounds));
      if (nearAny) {
        layers.delete(id);
        const index = layerIds.indexOf(id);
        if (index !== -1) {
          layerIds.delete(index);
        }
      }
    }

    for (const [id, layer] of layers.entries()) {
      const type = layer.get("type");
      if (type !== LayerType.Path) continue;

      const pathLayer = layer as LiveObject<PathLayer>;
      const immutable = pathLayer.toImmutable();

      if (!Array.isArray(immutable.points)) continue;

      const intersects = newDraft.some(p => {
        const hit = doesPointIntersectPath(p, immutable, id);
        return hit;
      });

      if (intersects) {
        layers.delete(id);
        const index = layerIds.indexOf(id);
        if (index !== -1) {
          layerIds.delete(index);
        }
      }
    }
  },
  [canvasState.mode]
);



  const stopErasing = useMutation(
    ({ setMyPresence }) => {
      setMyPresence({ eraserDraft: null });
    },
    []
  );

  const translateLayer = useMutation(({ storage, self }, point: Point) => {
    if (canvasState.mode !== BoardCanvasMode.Translating) return;

    const deltaX = point.x - canvasState.current.x;
    const deltaY = point.y - canvasState.current.y;

    if (deltaX === 0 && deltaY === 0) return;

    const liveLayers = storage.get("layers");

    for (const id of self.presence.selection) {
      const layer = liveLayers.get(id);
      if (!layer) continue;

      const prevX = layer.get("x") ?? 0;
      const prevY = layer.get("y") ?? 0;

      layer.update({
        x: prevX + deltaX,
        y: prevY + deltaY,
      });
    }

    setCanvasState({
      ...canvasState,
      current: point,
    });
  }, [canvasState]);

  const updateMyPresence = useUpdateMyPresence();

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const onResizeHandlePointerDown = useCallback(
    (corner: side, initialBounds: XYWH) => {
      // console.log("onResizeHandlePointerDown", { corner, initialBounds });
      history.pause();
      setCanvasState({ mode: BoardCanvasMode.Resizing, initial: initialBounds, corner });
    },
    [history]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();

      if (rafRef.current) return;

      const { clientX, clientY } = e;
      const svg = e.currentTarget as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const camera = cameraRef.current;

      rafRef.current = requestAnimationFrame(() => {
        const x = (clientX - rect.left - camera.x) / camera.scale;
        const y = (clientY - rect.top - camera.y) / camera.scale;
        const point = { x, y };

        if (canvasState.mode === BoardCanvasMode.Pressing) {
          startMultiSelect(point, canvasState.origin);
        } else if (canvasState.mode === BoardCanvasMode.SelectionNet) {
          updateSelectionNet(point, canvasState.origin);
        } else if (canvasState.mode === BoardCanvasMode.Translating) {
          translateLayer(point);
        } else if (canvasState.mode === BoardCanvasMode.Resizing) {
          resizeLayer(point);
        } else if (canvasState.mode === BoardCanvasMode.Pencil) {
          continueDrawing(point, e);
        } else if (canvasState.mode === BoardCanvasMode.Eraser) {
          continueErasing(point, e);
        } else if (canvasState.mode === BoardCanvasMode.Panning) {
            const dx = clientX - (canvasState.screenX ?? clientX);
            const dy = clientY - (canvasState.screenY ?? clientY);

            setCamera((prev) => ({
              ...prev,
              x: prev.x + dx,
              y: prev.y + dy,
            }));

            setCanvasState({
              ...canvasState,
              screenX: clientX,
              screenY: clientY,
            });
          }
        updateMyPresence({ cursor: point }, { addToHistory: false });

        rafRef.current = null;
      });
    },
    [
      updateMyPresence,
      canvasState,
      resizeLayer,
      translateLayer,
      continueDrawing,
      startMultiSelect,
      updateSelectionNet,
      setCamera,
      setCanvasState,
    ]
  );

  const onPointerLeave = useMutation((
    { setMyPresence }
  ) => {
    setMyPresence({ cursor: null });
  }, []);

  function getSelectionBounds(selection: string[], layers: LiveMap<string, LiveObject<Layer>>) {
    const selectedLayers = selection.map(id => layers.get(id)).filter(Boolean) as LiveObject<Layer>[];
    if (selectedLayers.length === 0) return null;

    const xs = selectedLayers.map(l => l.get("x") ?? 0);
    const ys = selectedLayers.map(l => l.get("y") ?? 0);
    const x2s = selectedLayers.map(l => (l.get("x") ?? 0) + (l.get("width") ?? 0));
    const y2s = selectedLayers.map(l => (l.get("y") ?? 0) + (l.get("height") ?? 0));

    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...x2s) - x;
    const height = Math.max(...y2s) - y;

    return { x, y, width, height };
  }

  const onPointerDown = useMutation(({ self, storage, setMyPresence }, e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);

    const svg = svgRef.current!;
    const point = pointerEventToCanvasPoint(e.clientX, e.clientY, cameraRef.current, svg);

    if (e.button === 1) {
      e.preventDefault();
      setCanvasState({
        mode: BoardCanvasMode.Panning,
        origin: point,
        current: point,
        screenX: e.clientX,
        screenY: e.clientY,
        previousState: canvasState,
      });
      return;
    }

    if (canvasState.mode === BoardCanvasMode.Inserting) return;
    if (canvasState.mode === BoardCanvasMode.Pencil) {
      startDrawing(point, e);
      return;
    }
    if (canvasState.mode === BoardCanvasMode.Eraser) {
      startErasing(point, e);
      return;
    }

    const layers = storage.get("layers");
    const selection = self.presence.selection;
    const selectionBounds = getSelectionBounds(selection, layers);

    const isInsideSelection =
      selectionBounds &&
      point.x >= selectionBounds.x &&
      point.x <= selectionBounds.x + selectionBounds.width &&
      point.y >= selectionBounds.y &&
      point.y <= selectionBounds.y + selectionBounds.height;

    if (isInsideSelection && selection.length > 0) {
      history.pause();
      setCanvasState({ mode: BoardCanvasMode.Translating, current: point });

    } else {
      setMyPresence({ selection: [] }, { addToHistory: true });
      setCanvasState({ origin: point, mode: BoardCanvasMode.Pressing });
    }
  }, [
    camera,
    canvasState,
    setCanvasState,
    startDrawing,
    startErasing,
  ]);


  const onPointerUp = useMutation(
    ({}, e: React.PointerEvent<SVGSVGElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);

      const svg = svgRef.current!;
      const point = pointerEventToCanvasPoint(e.clientX, e.clientY, cameraRef.current, svg);

      switch (canvasState.mode) {
        case BoardCanvasMode.Pencil:
          insertPath();
          history.resume();
          return;

        case BoardCanvasMode.Eraser:
          stopErasing();
          history.resume();
          return;

        case BoardCanvasMode.Inserting:
          insertLayer(canvasState.layerType!, point);
          setCanvasState({ mode: BoardCanvasMode.None });
          history.resume();
          return;

        case BoardCanvasMode.Panning:
          if (canvasState.previousState) {
            setCanvasState(canvasState.previousState);
          } else {
            setCanvasState({ mode: BoardCanvasMode.None });
          }
          history.resume();
          return;

        case BoardCanvasMode.Translating:
          setCanvasState({ mode: BoardCanvasMode.None });
          history.resume();
          return;

        case BoardCanvasMode.Pressing:
          unselectLayer();
          setCanvasState({ mode: BoardCanvasMode.None });
          history.resume();
          return;

        default:
          setCanvasState({ mode: BoardCanvasMode.None });
          history.resume();
      }
    },
    [
      canvasState,
      camera,
      history,
      insertLayer,
      insertPath,
      stopErasing,
      unselectLayer,
      setCanvasState,
    ]
  );

  function onPointerCancel(e: React.PointerEvent) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setCanvasState({ mode: BoardCanvasMode.None });
  } // TODO fix it (присутствует "залипание при выборе объектов")

  const selections = useOthersMapped((other) => other.presence.selection);

  const layersIdsToColorSelect = useMemo(() => {
    const layersIdsToColorSelect: Record<string,string> = {}
    for (const user of selections) {
      const [connectionId, selection] = user;

      for (const layerId of selection) {
        layersIdsToColorSelect[layerId] = connectionIdToColor(connectionId);
      }
    }

    return layersIdsToColorSelect
  }, [layerIds, selections]);

  const onLayerPointerDown = useMutation(
    ({ self, setMyPresence }, e: React.PointerEvent, layerId: string) => {
      if (
        canvasState.mode === BoardCanvasMode.Pencil ||
        canvasState.mode === BoardCanvasMode.Inserting
      ) {
        return;
      }

      history.pause();
      e.stopPropagation();

      const svg = svgRef.current!;
      const point = pointerEventToCanvasPoint(e.clientX, e.clientY, cameraRef.current, svg);

      const isAlreadyMultiSelected = self.presence.selection.length > 1;
      const clickedSelected = self.presence.selection.includes(layerId);

      if (!(isAlreadyMultiSelected && clickedSelected)) {
        setMyPresence({ selection: [layerId] }, { addToHistory: true });
      }

      setCanvasState({ mode: BoardCanvasMode.Translating, current: point });
    },
    [history, camera, canvasState.mode]
  );


  const deleteLayers = useDeleteLayers();

  const duplicateLayers = useMutation(({ storage, self, setMyPresence }) => {
    const selection = self.presence.selection;
    if (!selection.length) return;

    const layers = storage.get("layers");
    const layerIds = storage.get("layerIds");

    const originals = selection
      .map((id: string) => layers.get(id)?.toImmutable())
      .filter((l): l is Layer => Boolean(l));

    if (!originals.length) return;

    const newIds: string[] = [];
    const padding = 32;

    const bounds = originals.reduce(
      (acc, layer) => {
        const x = layer.x ?? 0;
        const y = layer.y ?? 0;
        const right = x + (layer.width ?? 0);
        const bottom = y + (layer.height ?? 0);
        return {
          minX: Math.min(acc.minX, x),
          minY: Math.min(acc.minY, y),
          maxX: Math.max(acc.maxX, right),
          maxY: Math.max(acc.maxY, bottom),
        };
      },
      {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      }
    );

    const canvasWidth = svgRef.current?.clientWidth ?? window.innerWidth;
    const moveDownInstead = bounds.maxX + padding > canvasWidth;

    const deltaX = moveDownInstead ? 0 : bounds.maxX - bounds.minX + padding;
    const deltaY = moveDownInstead ? bounds.maxY - bounds.minY + padding : 0;

    for (const layer of originals) {
      const newId = nanoid();

      const newLayer = new LiveObject({
        ...layer,
        x: (layer.x ?? 0) + deltaX,
        y: (layer.y ?? 0) + deltaY,
      });

      layers.set(newId, newLayer);
      layerIds.push(newId);
      newIds.push(newId);
    }

    setMyPresence({ selection: newIds }, { addToHistory: true });
  }, []);

  useEffect(() => { // handle keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.isContentEditable ||
        ["INPUT", "TEXTAREA"].includes(target.tagName)
      ) {
        return;
      }

      // только когда Ctrl и без других модификаторов
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        switch (e.code) {
          case "KeyZ":
            e.preventDefault();
            history.undo();
            break;
          case "KeyY":
            e.preventDefault();
            history.redo();
            break;
          case "KeyD":
            e.preventDefault();
            duplicateLayers();
            break;
          case "KeyP":
            e.preventDefault();
            setCanvasState((s) => ({ ...s, mode: BoardCanvasMode.Pencil }));
            break;
          case "KeyE":
            e.preventDefault();
            setCanvasState((s) => ({ ...s, mode: BoardCanvasMode.Eraser }));
            break;
          case "KeyT":
            e.preventDefault();
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Text,
            });
            break;
          case "KeyS":
            e.preventDefault();
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Sticker,
            });
            break;
          case "KeyR":
            e.preventDefault();
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Rectangle,
            });
            break;
          case "KeyO":
            e.preventDefault();
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Ellipse,
            });
            break;
        }
      } else if (e.key === "Escape") {
        setCanvasState({ mode: BoardCanvasMode.None });
        unselectLayer();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteLayers();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [history, setCanvasState, unselectLayer, deleteLayers]);

  const insertTextLayer = useMutation(
    ({ storage, setMyPresence }, value: string, position: Point) => {
      const liveLayers = storage.get("layers");
      const liveLayerIds = storage.get("layerIds");

      if (liveLayers.size >= MAX_LAYERS) {
        console.warn("Max layers reached");
        toast.error(t("canvas.max-layers-reached"));
        return;
      }

      const id = nanoid();
      const textLayer = new LiveObject<TextLayer>({
        type: LayerType.Text,
        x: position.x,
        y: position.y,
        width: 300,
        height: 100,
        value,
        fill: lastUsedColor,
      });

      liveLayers.set(id, textLayer);
      liveLayerIds.push(id);
      setMyPresence({ selection: [id] }, { addToHistory: true });
      setCanvasState({ mode: BoardCanvasMode.None });
    },
    [lastUsedColor]
  );

  const insertLinkPreviewLayer = useMutation(
    ({ storage, setMyPresence }, url: string, position: Point, previewData: any) => {
      // console.log("Preview data:", previewData);

      const layerIds = storage.get("layerIds");
      const layers = storage.get("layers");

      if (layers.size >= MAX_LAYERS) {
        toast.error(t("canvas.max-layers-reached"));
        return;
      }

      const id = nanoid();

      const layer = new LiveObject<LinkPreviewLayer>({
        type: LayerType.LinkPreview,
        x: position.x,
        y: position.y,
        width: 400,
        height: 150,
        value: url,
        title: previewData.title,
        description: previewData.description,
        image: previewData.image,
        favicon: previewData.favicon,
      });

      layers.set(id, layer);
      layerIds.push(id);
      setMyPresence({ selection: [id] }, { addToHistory: true });
      setCanvasState({ mode: BoardCanvasMode.None });
    },
    []
  );

  function useCopyPasteLayers(
    getSelf: () => any,
    updateMyPresence: ReturnType<typeof useUpdateMyPresence>,
    svgRef: React.RefObject<SVGSVGElement | null>
  ) {
    const lastPasteDataRef = useRef<string | null>(null);
    const pasteCountRef = useRef(0);

    const copyLayers = useMutation(({ storage, self }) => {
      const selection = self.presence.selection;
      if (!selection.length) return;

      const layers = storage.get("layers");
      const selected = selection
        .map((id: string) => layers.get(id)?.toImmutable())
        .filter(Boolean);

      const payload = JSON.stringify(selected);
      navigator.clipboard.writeText(payload).catch(() => {});
    }, []);

    const pasteLayers = useMutation(({ storage, setMyPresence }, clipText?: string) => {
      const read = clipText ? Promise.resolve(clipText) : navigator.clipboard.readText();
      read.then((text) => {
        try {
          if (!text) return;

          const sameAsLast = text === lastPasteDataRef.current;
          lastPasteDataRef.current = text;

          if (sameAsLast) {
            pasteCountRef.current += 1;
          } else {
            pasteCountRef.current = 0;
          }

          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) return;

          const layers = storage.get("layers");
          const layerIds = storage.get("layerIds");

          const newIds: string[] = [];
          const padding = 32;

          const bounds = parsed.reduce(
            (acc, layer) => {
              const x = layer.x ?? 0;
              const y = layer.y ?? 0;
              const right = x + (layer.width ?? 0);
              const bottom = y + (layer.height ?? 0);
              return {
                minX: Math.min(acc.minX, x),
                minY: Math.min(acc.minY, y),
                maxX: Math.max(acc.maxX, right),
                maxY: Math.max(acc.maxY, bottom),
              };
            },
            {
              minX: Infinity,
              minY: Infinity,
              maxX: -Infinity,
              maxY: -Infinity,
            }
          );

          const canvasWidth = svgRef.current?.clientWidth ?? window.innerWidth;
          const moveDownInstead = bounds.maxX + padding > canvasWidth;

          const offsetMultiplier = pasteCountRef.current + 1;
          const deltaX = moveDownInstead ? 0 : (bounds.maxX - bounds.minX + padding) * offsetMultiplier;
          const deltaY = moveDownInstead ? (bounds.maxY - bounds.minY + padding) * offsetMultiplier : 0;

          for (const layer of parsed) {
            const newId = nanoid();

            const newLayer = new LiveObject({
              ...layer,
              x: (layer.x ?? 0) + deltaX,
              y: (layer.y ?? 0) + deltaY,
            });

            layers.set(newId, newLayer);
            layerIds.push(newId);
            newIds.push(newId);
          }

          setMyPresence({ selection: newIds }, { addToHistory: true });
        } catch {
          console.error("Failed to parse clipboard data", text);
          toast.error("Не удалось вставить данные из буфера обмена");
        }
      });
    }, []);



    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && !e.shiftKey && !e.altKey) {
          if (e.code === "KeyC") {
            e.preventDefault();
            copyLayers();
          }
        }
      };
      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [copyLayers]);

    return { pasteLayers}
  }

  const { pasteLayers } = useCopyPasteLayers(() => self, updateMyPresence, svgRef);

  useEffect(() => { // handle clipboard
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      const cursor = self.presence.cursor ?? { x: 100, y: 100 };

      if (text && isLayerClipboardData(text)) {
        e.preventDefault();
        pasteLayers(text);
        return;
      }

      if (text?.startsWith("http")) {
        try {
          const res = await fetch(`/api/fetch-link-preview?url=${encodeURIComponent(text)}`);
          const data = await res.json();

          insertLinkPreviewLayer(text, cursor, data);
        } catch (error) {
          console.error("Link preview fetch failed", error);
          toast.error("Не удалось получить preview");
        }
        return;
      }
      if (text) {
        insertTextLayer(text, cursor); // TODO: resize layer to fit text 
        return;
      }

      if (items) {
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;

            const formData = new FormData();
            formData.append("file", file);

            try {
              const response = await fetch("/api/upload-image", {
                method: "POST",
                body: formData,
              });

              const data = await response.json();
              if (data.url) {
                insertImageLayer(data.url, cursor);
              }
            } catch (err) {
              console.error("Paste image upload failed:", err);
              toast.error(t("canvas.pasteImageError"));
            }
          }
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [insertTextLayer, insertImageLayer, self.presence.cursor, pasteLayers]);

  useEffect(() => { // handle wheel scroll
    const svg = svgRef.current;
    if (!svg) {
      console.warn("❌ svgRef.current is null");
      return;
    }

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();

        const rect = svg.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;

        const camera = cameraRef.current;

        const cursorX = (offsetX - camera.x) / camera.scale;
        const cursorY = (offsetY - camera.y) / camera.scale;

        const scaleFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const newScale = Math.max(0.1, Math.min(4, camera.scale * scaleFactor));

        const newCameraX = offsetX - cursorX * newScale;
        const newCameraY = offsetY - cursorY * newScale;

        setCamera({
          x: newCameraX,
          y: newCameraY,
          scale: newScale,
        });
      } else {
        setCamera((prev) => ({
          ...prev,
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    svg.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      svg.removeEventListener("wheel", handleWheel);
    };
  }, []);


  return (
    <main className="h-full w-full relative bg-neutral touch-none">
      <BoardInfo boardId={boardId} />
      <div className="absolute top-2 right-2 flex flex-row-reverse items-center gap-2">
        <BoardParticipants />
        <SessionTimer />
      </div>

      <BoardToolbar
        canvasState={canvasState}
        setCanvasState={setCanvasState}
        undo={history.undo}
        redo={history.redo}
        canUndo={canUndo}
        canRedo={canRedo}
        selectedPenSize={lastUsedSize} 
        onImageUpload={(url) => {
          const cursor = self.presence.cursor ?? { x: 100, y: 100 };
          insertImageLayer(url, cursor);
        }}
        onPenSizeChange={(size) => {
        setLastUsedSize(size);
        setCanvasState({ mode: BoardCanvasMode.Pencil });
      }}
        setCamera={setCamera}
      />
      <SelectionTools
        camera={camera}
        setLastUsedColor={setLastUsedColor}
      />
       
      <svg
        ref={svgRef}
        className="h-[100vh] w-[100vw]"
        onPointerMove={onPointerMove}
        /* TODO: fix onPointerLeave={onPointerLeave} */
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{
          cursor:
            canvasState.mode === BoardCanvasMode.Pencil
              ? 'url("/cursors/pencil.svg") 2 14, auto'
            : canvasState.mode === BoardCanvasMode.Eraser
              ? 'url("/cursors/eraser.svg") 4 4, auto'
            : canvasState.mode === BoardCanvasMode.Inserting
              ? 'crosshair'
            : canvasState.mode === BoardCanvasMode.Panning
              ? 'grabbing'
            : 'default',
        }}
      >
        <GridBackground camera={camera} />
        <g style={{
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          transformOrigin: "0 0",
        }}>
          {layerIds.map((layerId) => (
            <LayerPreview 
              key={layerId} 
              id={layerId}
              onLayerPointerDown={onLayerPointerDown}
              selectionColor={layersIdsToColorSelect[layerId]}
            />
          ))}
          <SelectionBox
           onResizeHandlePointerDown={onResizeHandlePointerDown}
          />
          {canvasState.mode === BoardCanvasMode.SelectionNet && canvasState.current != null&& (
            <rect
              className="fill-blue-500/5 stroke-blue-500 stroke-1"
              x={Math.min(canvasState.origin.x, canvasState.current.x)}
              y={Math.min(canvasState.origin.y, canvasState.current.y)}
              width={Math.abs(canvasState.origin.x - canvasState.current.x)}
              height={Math.abs(canvasState.origin.y - canvasState.current.y)}
            />
          )}
          <CursorsPresence />
          {pencilDraft != null && pencilDraft.length > 0 && (
            <Path
                points={pencilDraft}
                x={0}
                y={0}
                fill={rgbToCss(lastUsedColor)}
                size={lastUsedSize}
            />
          )}
        </g>
      </svg>
    </main>
  );
};

