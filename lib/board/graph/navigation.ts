import type { GraphViewport } from "../../../types/board-canvas";

const MIN_SPAN = 0.0001;
const MAX_SPAN = 1_000_000;

export function boundedGraphViewport(value: GraphViewport): GraphViewport {
  const axis = (min: number, max: number): readonly [number, number] => {
    // Leave a few ULPs so subtraction near large coordinates stays above the schema minimum.
    const span = Math.max(MIN_SPAN + Number.EPSILON * MAX_SPAN * 8, Math.min(MAX_SPAN, max - min));
    const center = Math.max(-MAX_SPAN + span / 2, Math.min(MAX_SPAN - span / 2, (min + max) / 2));
    return [center - span / 2, center + span / 2];
  };
  const [xMin, xMax] = axis(value.xMin, value.xMax);
  const [yMin, yMax] = axis(value.yMin, value.yMax);
  return { xMin, xMax, yMin, yMax };
}

/** Screen-space fractions: positive dx moves the plotted content right. */
export function panGraphViewport(viewport: GraphViewport, dx: number, dy: number): GraphViewport {
  const x = (viewport.xMax - viewport.xMin) * dx;
  const y = (viewport.yMax - viewport.yMin) * dy;
  return boundedGraphViewport({ xMin: viewport.xMin - x, xMax: viewport.xMax - x,
    yMin: viewport.yMin + y, yMax: viewport.yMax + y });
}

export function zoomGraphViewport(viewport: GraphViewport, factor: number, x = 0.5, y = 0.5): GraphViewport {
  const anchorX = viewport.xMin + (viewport.xMax - viewport.xMin) * x;
  const anchorY = viewport.yMax - (viewport.yMax - viewport.yMin) * y;
  return boundedGraphViewport({
    xMin: anchorX + (viewport.xMin - anchorX) * factor,
    xMax: anchorX + (viewport.xMax - anchorX) * factor,
    yMin: anchorY + (viewport.yMin - anchorY) * factor,
    yMax: anchorY + (viewport.yMax - anchorY) * factor,
  });
}
