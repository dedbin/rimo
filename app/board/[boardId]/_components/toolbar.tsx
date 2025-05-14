import { Circle, MousePointer2, Pencil, Redo2, Square, StickyNote, Type, Undo2 } from "lucide-react";
import { ToolButton } from "./tool-button";

export const BoardToolbar = () => {
    return (
        <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4">
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-1 items-center">
                <ToolButton
                    label="select"
                    icon={MousePointer2}
                    onClick={() => {}}
                    isActive={false} // TODO: make this work
                />
                <ToolButton
                    label="text"
                    icon={Type}
                    onClick={() => {}}
                    isActive={false} // TODO: make this work
                />
                <ToolButton
                    label="pen"
                    icon={Pencil}
                    onClick={() => {}}
                    isActive={false} // TODO: make this work
                />
                <ToolButton
                    label="stickers"
                    icon={StickyNote}
                    onClick={() => {}}
                    isActive={false} // TODO: make this work
                />
                <ToolButton
                    label="rectangle"
                    icon={Square}
                    onClick={() => {}}
                    isActive={false} // TODO: make this work
                />
                <ToolButton
                    label="ellipse"
                    icon={Circle}
                    onClick={() => {}}
                    isActive={false} // TODO: make this work
                />
            </div>
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col items-center">
                <ToolButton
                    label="undo"
                    icon={Undo2}
                    onClick={() => {}}
                    isDisabled={false} // TODO: make this work
                />
                <ToolButton
                    label="redo"
                    icon={Redo2}
                    onClick={() => {}}
                    isDisabled={false} // TODO: make this work
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