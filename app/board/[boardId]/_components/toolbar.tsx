import { Circle, MousePointer2, Pencil, Redo2, Square, StickyNote, Type, Undo2 } from "lucide-react";
import { ToolButton } from "./tool-button";
import { BoardCanvasMode, BoardCanvasState, LayerType } from "@/types/board-canvas";



interface BoardToolbarProps {
    canvasState: BoardCanvasState;
    setCanvasState: (canvasState: BoardCanvasState) => void;
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
}

export const BoardToolbar = ({canvasState, setCanvasState, undo, redo, canUndo, canRedo}: BoardToolbarProps) => {
    return (
        <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4">
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-1 items-center">
                <ToolButton
                    label="select"
                    icon={MousePointer2}
                    onClick={() => setCanvasState({
                        mode: BoardCanvasMode.None
                    })}
                    isActive={
                        canvasState.mode === BoardCanvasMode.None || 
                        canvasState.mode === BoardCanvasMode.Translating ||
                        canvasState.mode === BoardCanvasMode.SelectionNet ||
                        canvasState.mode === BoardCanvasMode.Pressing ||
                        canvasState.mode === BoardCanvasMode.Resizing                        
                    } 
                />
                <ToolButton
                    label="text"
                    icon={Type}
                    onClick={() => setCanvasState({
                        mode: BoardCanvasMode.Inserting, layerType: LayerType.Text
                    })}
                    isActive={
                        canvasState.mode === BoardCanvasMode.Inserting &&
                        canvasState.layerType === LayerType.Text
                    }
                />
                <ToolButton
                    label="pen"
                    icon={Pencil}
                    onClick={() => setCanvasState({
                        mode: BoardCanvasMode.Pencil
                    })}
                    isActive={
                        canvasState.mode === BoardCanvasMode.Pencil
                    }  
                />
                <ToolButton
                    label="stickers"
                    icon={StickyNote}
                    onClick={() => setCanvasState({
                        mode: BoardCanvasMode.Inserting,
                        layerType: LayerType.Sticker
                    })}
                    isActive={
                        canvasState.mode === BoardCanvasMode.Inserting &&
                        canvasState.layerType === LayerType.Sticker
                    } 
                />
                <ToolButton
                    label="rectangle"
                    icon={Square}
                    onClick={() => setCanvasState({
                        mode: BoardCanvasMode.Inserting,
                        layerType: LayerType.Rectangle
                    })}
                    isActive={
                        canvasState.mode === BoardCanvasMode.Inserting &&
                        canvasState.layerType === LayerType.Rectangle
                    } 
                />
                <ToolButton
                    label="ellipse"
                    icon={Circle}
                    onClick={() => setCanvasState({
                        mode: BoardCanvasMode.Inserting,
                        layerType: LayerType.Ellipse
                    })}
                    isActive={
                        canvasState.mode === BoardCanvasMode.Inserting &&
                        canvasState.layerType === LayerType.Ellipse
                    } 
                />
            </div>
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col items-center">
                <ToolButton
                    label="undo"
                    icon={Undo2}
                    onClick={undo}
                    isDisabled={!canUndo} 
                />
                <ToolButton
                    label="redo"
                    icon={Redo2}
                    onClick={redo}
                    isDisabled={!canRedo} 
                />
            </div>
        </div>
    );
};

export const BoardToolbarSkeleton = () => {
    return (
        <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4">
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
                {[...Array(4)].map((_, i) => (
                    <div key={`tool-skel-${i}`} className="h-8 w-8 bg-muted animate-pulse rounded" />
                ))}
            </div>
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
                {[...Array(2)].map((_, i) => (
                    <div key={`action-skel-${i}`} className="h-8 w-8 bg-muted animate-pulse rounded" />
                ))}
            </div>
        </div>
    );
};