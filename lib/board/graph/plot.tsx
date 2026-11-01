import { Coordinates, Mafs, Plot } from "mafs";
// The PDF worker runs with tsx's classic JSX runtime; Next uses automatic JSX.
import React, { useId, useMemo } from "react";
import type { SVGProps } from "react";

import type { GraphExpression, GraphSettings } from "../../../types/board-canvas";
import { compileGraphExpression } from "./expression";
import type { GraphDomainBoundary, GraphExpressionCompilation } from "./expression";
import { MAX_GRAPH_EXPRESSIONS, sortedGraphExpressions } from "./model";

type Compiled = Extract<GraphExpressionCompilation, { ok: true }>;
type Interval = [number, number];
interface PreparedCurve { readonly id: string; readonly expression: GraphExpression; readonly compiled: Compiled; readonly intervals: Interval[] }
interface Segments { readonly intervals: Interval[]; readonly limited: boolean }

const DOMAIN_PROBES = 256;
const MAX_CURVE_SEGMENTS = 16;
const MAX_PLOT_SAMPLES = 16_384;

function between(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function boundaryPoints(boundaries: readonly GraphDomainBoundary[], domain: Interval): { points: number[]; limited: boolean } {
  const [min, max] = domain;
  const step = (max - min) / DOMAIN_PROBES;
  const points: number[] = [];
  const tolerance = (max - min) * 1e-10;
  function add(boundary: GraphDomainBoundary, root: number, left: number, right: number): void {
    const scale = Math.max(1, ...[boundary.validate(left), boundary.validate(right)].filter(Number.isFinite).map(Math.abs));
    const target = boundary.validate(root);
    if (!Number.isFinite(target) || Math.abs(target) > Number.EPSILON * 64 * scale) return;
    if (!points.some((point) => Math.abs(root - point) <= tolerance)) points.push(root);
  }
  for (const boundary of boundaries) {
    let left = min;
    let leftValue = boundary.evaluate(left);
    if (leftValue === 0) add(boundary, left, left, left + step);
    for (let index = 1; index <= DOMAIN_PROBES; index += 1) {
      const right = index === DOMAIN_PROBES ? max : min + index * step;
      const rightValue = boundary.evaluate(right);
      if (rightValue === 0) add(boundary, right, left, right);
      if (Number.isFinite(leftValue) && Number.isFinite(rightValue) && leftValue !== 0 && rightValue !== 0 &&
        (leftValue < 0) !== (rightValue < 0)) {
        let lower = left;
        let upper = right;
        for (let attempt = 0; attempt < 48; attempt += 1) {
          const middle = (lower + upper) / 2;
          const middleValue = boundary.evaluate(middle);
          if (!Number.isFinite(middleValue) || middle === lower || middle === upper) break;
          if (middleValue === 0) { lower = middle; upper = middle; break; }
          if ((middleValue < 0) === (leftValue < 0)) lower = middle;
          else upper = middle;
        }
        add(boundary, (lower + upper) / 2, left, right);
      }
      if (points.length >= MAX_CURVE_SEGMENTS) return { points: [], limited: true };
      left = right;
      leftValue = rightValue;
    }
  }
  return { points: points.sort((left, right) => left - right), limited: false };
}

// Mafs skips non-finite samples without lifting the pen. Give its adaptive
// sampler separate continuous domains so poles do not become vertical strokes.
export function graphPlotSegments(evaluate: Compiled["evaluate"], domain: Interval, range: Interval,
  boundaries: readonly GraphDomainBoundary[] = []): Segments {
  const [min, max] = domain;
  const rangeSpan = range[1] - range[0];
  const step = (max - min) / DOMAIN_PROBES;
  const intervals: Interval[] = [];
  let start: number | null = null;
  let previousX = min;
  let previousValue = evaluate(min);
  if (Number.isFinite(previousValue)) start = min;

  function domainEdge(left: number, right: number, leftFinite: boolean): number {
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const middle = (left + right) / 2;
      if (Number.isFinite(evaluate(middle)) === leftFinite) left = middle;
      else right = middle;
    }
    return leftFinite ? left : right;
  }

  function pole(left: number, right: number, leftValue: number, rightValue: number): Interval | null {
    const center = leftValue / 2 + rightValue / 2;
    const deviation = Math.abs(leftValue / 2 - rightValue / 2);
    if (deviation < rangeSpan / (DOMAIN_PROBES * 16)) return null;
    const leftBelow = leftValue < center;
    let diverged = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const middle = (left + right) / 2;
      const value = evaluate(middle);
      if (!Number.isFinite(value)) return [domainEdge(left, middle, true), domainEdge(middle, right, false)];
      const offset = Math.abs(value - center);
      if (offset <= deviation / 4) return null;
      if (offset > deviation * 4) diverged = true;
      if ((value < center) === leftBelow) left = middle;
      else right = middle;
    }
    return diverged ? [left, right] : null;
  }

  for (let index = 1; index <= DOMAIN_PROBES; index += 1) {
    const x = index === DOMAIN_PROBES ? max : min + index * step;
    const value = evaluate(x);
    const previousFinite = Number.isFinite(previousValue);
    const finite = Number.isFinite(value);
    if (previousFinite && !finite && start !== null) {
      intervals.push([start, domainEdge(previousX, x, true)]);
      start = null;
    } else if (!previousFinite && finite) {
      start = domainEdge(previousX, x, false);
    } else if (previousFinite && finite && start !== null) {
      const gap = pole(previousX, x, previousValue, value);
      if (gap) { intervals.push([start, gap[0]]); start = gap[1]; }
    }
    if (intervals.length > MAX_CURVE_SEGMENTS) return { intervals: [], limited: true };
    previousX = x;
    previousValue = value;
  }
  if (start !== null && start < max) intervals.push([start, max]);
  const critical = intervals.length ? boundaryPoints(boundaries, domain) : { points: [], limited: false };
  if (critical.limited) return { intervals: [], limited: true };
  const gap = (max - min) * 1e-10;
  const split: Interval[] = [];
  for (const [left, right] of intervals) {
    let lower = left;
    for (const point of critical.points) {
      if (point < lower || point > right) continue;
      if (point - gap > lower) split.push([lower, point - gap]);
      lower = point + gap;
    }
    if (right > lower) split.push([lower, right]);
  }
  return { intervals: split, limited: split.length > MAX_CURVE_SEGMENTS };
}

function gridStep(span: number, pixels: number): number {
  const approximate = span / Math.max(2, Math.min(30, pixels / 64));
  const magnitude = 10 ** Math.floor(Math.log10(approximate));
  const scaled = approximate / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
}

function axisLabel(value: number, step: number): string {
  if (Math.abs(value) >= 100_000 && step >= 1_000) return value.toExponential(1);
  const decimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(step))));
  return Number(value.toFixed(decimals)).toString().replace("-", "−");
}

function PreparedExpression({ curve, graph, depth, prefix }: {
  curve: PreparedCurve; graph: GraphSettings; depth: number; prefix: string;
}) {
  const { compiled, expression, intervals, id } = curve;
  const { viewport } = graph;
  const vertical = compiled.axis === "y";
  const range: Interval = vertical ? [viewport.yMin, viewport.yMax] : [viewport.xMin, viewport.xMax];
  const span = range[1] - range[0];
  const minSamplingDepth = Math.min(6, Math.max(2, depth - 2));
  const style = { color: expression.color, weight: 2.25, minSamplingDepth, maxSamplingDepth: depth };
  const bounded = (value: number): number => {
    const output = compiled.evaluate(value);
    return Number.isFinite(output) ? between(output, range[0] - span * 4, range[1] + span * 4) : NaN;
  };
  return <g data-graph-expression={id} data-graph-axis={compiled.axis} data-graph-operator={compiled.operator}>
    {intervals.map(([min, max], index) => {
      if (compiled.operator === "=") return vertical
        ? <Plot.OfX key={index} y={bounded} domain={[min, max]} {...style} />
        : <Plot.OfY key={index} x={bounded} domain={[min, max]} {...style} />;
      const clipId = `${prefix}-${id}-${index}`;
      const evaluate = (value: number): number => bounded(between(value, min, max));
      const functions = { [compiled.operator]: evaluate };
      return <g key={index} clipPath={`url(#${clipId})`}>
        <defs><clipPath id={clipId}><rect
          x={vertical ? min : viewport.xMin} y={vertical ? viewport.yMin : min}
          width={vertical ? max - min : viewport.xMax - viewport.xMin}
          height={vertical ? viewport.yMax - viewport.yMin : max - min}
          style={{ transform: "var(--mafs-view-transform)" }} /></clipPath></defs>
        <Plot.Inequality {...(vertical ? { y: functions } : { x: functions })} {...style} fillOpacity={0.14}
          svgFillPathProps={{ "data-graph-shading": "true" } as SVGProps<SVGPathElement>} />
      </g>;
    })}
  </g>;
}

export function GraphPlot({ graph, width, height }: { graph: GraphSettings; width: number; height: number }) {
  const prefix = `graph-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const viewport = graph.viewport;
  const xSpan = viewport.xMax - viewport.xMin;
  const ySpan = viewport.yMax - viewport.yMin;
  const prepared = useMemo(() => {
    const curves: PreparedCurve[] = [];
    let limited = false;
    const visible = sortedGraphExpressions(graph).filter(([, expression]) => expression.visible);
    for (const [id, expression] of visible.slice(0, MAX_GRAPH_EXPRESSIONS)) {
      const compiled = compileGraphExpression(expression.formula);
      if (!compiled.ok) continue;
      const domain: Interval = compiled.axis === "y" ? [viewport.xMin, viewport.xMax] : [viewport.yMin, viewport.yMax];
      const range: Interval = compiled.axis === "y" ? [viewport.yMin, viewport.yMax] : [viewport.xMin, viewport.xMax];
      const segments = graphPlotSegments(compiled.evaluate, domain, range, compiled.domainBoundaries);
      limited ||= segments.limited;
      if (!segments.limited) curves.push({ id, expression, compiled, intervals: segments.intervals });
    }
    return { curves, limited, overflow: visible.length > MAX_GRAPH_EXPRESSIONS };
  }, [graph, viewport]);
  const segmentCount = prepared.curves.reduce((count, curve) => count + curve.intervals.length, 0);
  const depth = Math.min(9, Math.max(4, Math.floor(Math.log2(MAX_PLOT_SAMPLES / Math.max(1, segmentCount))) - 1));
  const xStep = gridStep(xSpan, width);
  const yStep = gridStep(ySpan, height);
  const xZero = -viewport.xMin / xSpan * width;
  const yZero = viewport.yMax / ySpan * height;
  const label = (value: number, min: number, span: number, pixels: number, step: number): string => {
    const position = (value - min) / span * pixels;
    return position < 18 || position > pixels - 18 ? "" : axisLabel(value, step);
  };
  return <div className="rimo-graph" data-graph-plot="true" data-graph-grid={graph.showGrid} style={{ width, height }}>
    <Mafs width={width} height={height} pan={false} zoom={false} ssr preserveAspectRatio={false}
      viewBox={{ x: [viewport.xMin, viewport.xMax], y: [viewport.yMin, viewport.yMax], padding: 0 }}>
      <Coordinates.Cartesian
        xAxis={{ lines: xStep, labels: (value) => label(value, viewport.xMin, xSpan, width, xStep) }}
        yAxis={{ lines: yStep, labels: (value) => label(value, viewport.yMin, ySpan, height, yStep) }} />
      {prepared.curves.map((curve) => <PreparedExpression key={curve.id} curve={curve} graph={graph} depth={depth} prefix={prefix} />)}
    </Mafs>
    {yZero >= 0 && yZero <= height && <span className="rimo-graph-axis-label" style={{ right: 4, top: between(yZero - 19, 2, height - 18) }}>x</span>}
    {xZero >= 0 && xZero <= width && <span className="rimo-graph-axis-label" style={{ left: between(xZero + 8, 2, width - 18), top: 2 }}>y</span>}
    {(prepared.limited || prepared.overflow) && <span className="rimo-graph-warning" style={{ position: "absolute", left: 8, bottom: 4, fontSize: 10, color: "#b45309" }}>
      {prepared.overflow ? `Показаны первые ${MAX_GRAPH_EXPRESSIONS} видимых выражений. Скройте лишние.` : "Слишком много разрывов. Уменьшите область графика."}
    </span>}
  </div>;
}
