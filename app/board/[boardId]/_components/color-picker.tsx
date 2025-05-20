"use client";

import { rgbToCss } from "@/lib/utils";
import { Color } from "@/types/board-canvas";

interface ColorPickerProps {
    onChange: (color: Color) => void
}

interface ColorButtonProps {
    color: Color
    onClick: (color: Color) => void
}

const ColorButton = ({color, onClick}: ColorButtonProps) => {
    return (
        <button className="w-8 h-8 items-center flex justify-center hover:opacity-75 transition" onClick={() => onClick(color)}>
            <div className="w-8 h-8 rounded-md border border-neutral-300" style={{background: rgbToCss(color)}}/>
        </button>
    )
}

export const ColorPicker = ({ onChange }: ColorPickerProps) => {
    const colors: Color[] = [
        { r: 0, g: 0, b: 0 },       // black
        { r: 255, g: 255, b: 255 }, // white
        { r: 52, g: 211, b: 153 },  // emerald
        { r: 59, g: 130, b: 246 },  // blue
        { r: 168, g: 85, b: 247 },  // purple
        { r: 239, g: 68, b: 68 },   // red
        { r: 234, g: 179, b: 8 },   // yellow
        { r: 249, g: 115, b: 22 },  // orange
    ];

    return (
        <div className="grid grid-cols-4 grid-rows-2 gap-2 p-2 border border-neutral-200">
            {colors.map((color, index) => (
                <ColorButton key={index} color={color} onClick={onChange} />
            ))}
        </div>
    );
};