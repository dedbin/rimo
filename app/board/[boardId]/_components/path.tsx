import { convertPointsToPath } from "@/lib/utils";
import getStroke from "perfect-freehand";
import { memo, useMemo } from "react";

interface PathProps {
    x: number;
    y: number;
    points: number[][];
    fill: string;
    onPointerDown?: (e: React.PointerEvent, id: string) => void;
    stroke?: string;
    size?: number;
}

export const Path = memo(({ x, y, points, fill, onPointerDown, stroke, size }: PathProps) => {
    const outline = useMemo(() => convertPointsToPath(getStroke(points, { size: size ?? 16, thinning: 0.5, smoothing: 0.5, streamline: 0.5 })), [points, size]);
    return (
        <path
            className="drop-shadow-md"
            d={outline}
            onPointerDown={(e) => onPointerDown && onPointerDown(e, "path")}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            x = {0}
            y = {0}
            fill={fill}
            stroke={stroke || 'transparent'}
            strokeWidth={1}
        />
    )
});
Path.displayName = "Path";
