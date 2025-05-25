"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BoardCanvasState,
  BoardCanvasMode,
  Camera,
  Color,
  LayerType,
  Point,
  side,
  XYWH,
  ImageLayer,
  StickerLayer,
  TextLayer,
  EllipseLayer,
  RectangleLayer,
  Layer,
} from "@/types/board-canvas";

import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import {
  useHistory,
  useCanRedo,
  useCanUndo,
  useUpdateMyPresence,
  useMutation,
  useStorage,
  useSelf,
  useOthersMapped
} from "@liveblocks/react/suspense";
import { CursorsPresence } from "./cursors-presence";
import { connectionIdToColor, pickLayersInBox, pointerEventToCanvasPoint, resizeBounds, measureText, makePathLayer, rgbToCss  } from "@/lib/utils";
import { nanoid } from "nanoid";
import { LiveObject } from "@liveblocks/client";
import { LayerPreview } from "./layer-preview";
import { SelectionBox } from "./selection-box";
import { SelectionTools } from "./selection-tools";
import { Path } from "./path";
import { useDeleteLayers } from "@/hooks/use-delete-layers";
import { toast } from "sonner";
import { useTranslation } from "@/hooks/use-translation";

const MAX_LAYERS = 100;
const SELECTION_THRESHOLD = 5;
const MIN_FONT_SIZE = 12;
const PADDING_X = 8;
const PADDING_Y = 4;

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
    layerType: LayerType.Ellipse | LayerType.Rectangle | LayerType.Sticker | LayerType.Text | LayerType.Image,
    position: Point
  ) => {
    const liveLayers = storage.get("layers");

    if (liveLayers.size >= MAX_LAYERS) {
      console.warn("Max layers reached");
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
      const text = layer.get("value") || "";
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

    if (!draft || draft.length < 2 || layers.size >= MAX_LAYERS) {
      setMyPresence({ pencilDraft: null });
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


const translateLayer = useMutation(({ storage, self }, point: Point) => {
    if (canvasState.mode !== BoardCanvasMode.Translating) return;

    const deltaX = point.x - canvasState.current.x;
    const deltaY = point.y - canvasState.current.y;

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

  const onPointerDown = useCallback((e: React.PointerEvent) => {
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
      });
      return;
    }


    if (canvasState.mode === BoardCanvasMode.Inserting) return;

    if (canvasState.mode == BoardCanvasMode.Pencil) {
      startDrawing(point, e);
      return
    }

    setCanvasState({ origin: point, mode: BoardCanvasMode.Pressing });
  }, [camera, canvasState.mode, setCanvasState, startDrawing]);

  const onPointerUp = useMutation(
    ({}, e: React.PointerEvent<SVGSVGElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);

      const svg = svgRef.current!;
      const point = pointerEventToCanvasPoint(e.clientX, e.clientY, cameraRef.current, svg);

      if (canvasState.mode === BoardCanvasMode.Pencil) {
        insertPath();
        history.resume();
        return;
      }

      if (
        canvasState.mode === BoardCanvasMode.None ||
        canvasState.mode === BoardCanvasMode.Pressing
      ) {
        unselectLayer();
        setCanvasState({ mode: BoardCanvasMode.None });
      } else if (canvasState.mode === BoardCanvasMode.Inserting) {
        insertLayer(canvasState.layerType!, point);
        setCanvasState({ mode: BoardCanvasMode.None });
      } else if (canvasState.mode === BoardCanvasMode.Panning) {
        setCanvasState({ mode: BoardCanvasMode.None });
        return;
      } else {
        setCanvasState({ mode: BoardCanvasMode.None });
      } 

      history.resume();
    },
    [
      canvasState,
      camera,
      history,
      insertLayer,
      unselectLayer,
      insertPath,
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
    if (canvasState.mode === BoardCanvasMode.Pencil || canvasState.mode === BoardCanvasMode.Inserting) {
      return;
    }

    history.pause();
    e.stopPropagation();

    const svg = svgRef.current!;
    const point = pointerEventToCanvasPoint(e.clientX, e.clientY, cameraRef.current, svg);

    setMyPresence({ selection: [layerId] }, { addToHistory: true });
    setCanvasState({ mode: BoardCanvasMode.Translating, current: point });
  },
  [history, camera, canvasState.mode]
);


  const deleteLayers = useDeleteLayers();
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
          case "KeyP":
            e.preventDefault();
            setCanvasState((s) => ({ ...s, mode: BoardCanvasMode.Pencil }));
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

  useEffect(() => { // handle clipboard
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      const text = e.clipboardData?.getData("text/plain")?.trim();
      const cursor = self.presence.cursor ?? { x: 100, y: 100 };

      // ⬇️ Текст
      if (text) {
        insertTextLayer(text, cursor); // TODO: resize layer to fit text 
        return;
      }

      // ⬇️ Картинка
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
                insertImageLayer(data.url, cursor); // 👈 передаём позицию
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
  }, [insertTextLayer, insertImageLayer, self.presence.cursor]);

  useEffect(() => { // handle wheel
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
      <BoardParticipants />

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
              : canvasState.mode === BoardCanvasMode.Inserting
                ? 'crosshair'
              : canvasState.mode === BoardCanvasMode.Panning
                ? 'grabbing'
              : 'default',
        }}
      >
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
          )}onPointerUp 
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

