import React from "react";

interface GridBackgroundProps {
  camera: { x: number; y: number; scale: number };
}

export const GridBackground: React.FC<GridBackgroundProps> = ({ camera }) => {
  const lines: React.ReactElement[] = [];

  const width = window.innerWidth;
  const height = window.innerHeight;

  const left = -camera.x / camera.scale;
  const top = -camera.y / camera.scale;
  const right = left + width / camera.scale;
  const bottom = top + height / camera.scale;

  const worldToScreenX = (x: number) => x * camera.scale + camera.x;
  const worldToScreenY = (y: number) => y * camera.scale + camera.y;

  // Adaptive grid step
  let spacing = 100;
  if (camera.scale > 2) spacing = 10;
  else if (camera.scale > 1.2) spacing = 25;
  else if (camera.scale > 0.6) spacing = 50;
  else if (camera.scale > 0.3) spacing = 100;
  else spacing = 200;

  const color = spacing <= 25 ? "#d0d0d0" : "#e0e0e0";
  const strokeWidth = 1;

  const startX = Math.floor(left / spacing) * spacing;
  const endX = Math.ceil(right / spacing) * spacing;
  for (let x = startX; x <= endX; x += spacing) {
    const sx = worldToScreenX(x);
    lines.push(
      <line
        key={`v-${x}`}
        x1={sx}
        x2={sx}
        y1={0}
        y2={height}
        stroke={color}
        strokeWidth={strokeWidth}
      />
    );
  }

  const startY = Math.floor(top / spacing) * spacing;
  const endY = Math.ceil(bottom / spacing) * spacing;
  for (let y = startY; y <= endY; y += spacing) {
    const sy = worldToScreenY(y);
    lines.push(
      <line
        key={`h-${y}`}
        x1={0}
        x2={width}
        y1={sy}
        y2={sy}
        stroke={color}
        strokeWidth={strokeWidth}
      />
    );
  }

  return <g>{lines}</g>;
};