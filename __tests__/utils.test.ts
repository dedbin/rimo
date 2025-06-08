import { describe, it, expect } from 'vitest';
import { cn, connectionIdToColor, pointerEventToCanvasPoint, rgbToCss, resizeBounds, pickLayersInBox, getContrastingTextColor, measureText, makePathLayer, convertPointsToPath, isPointNearBoundingBox, doesPointIntersectPath, getLayerBounds } from '../lib/utils';
import { side, LayerType, PathLayer, Layer } from '../types/board-canvas';
import { LiveObject } from '@liveblocks/client';

describe('utils', () => {
  it('cn merges classes correctly', () => {
    expect(cn('a', { b: true, c: false }, 'd')).toBe('a b d');
  });

  it('connectionIdToColor returns hex color', () => {
    const color = connectionIdToColor(1);
    expect(color).toMatch(/^#([0-9a-f]{6})$/i);
    expect(connectionIdToColor(1)).toBe(color);
  });

  it('pointerEventToCanvasPoint computes coordinates', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    // mock bounding rect
    Object.defineProperty(svg, 'getBoundingClientRect', { value: () => ({ left: 10, top: 20 }) });
    const camera = { x: 0, y: 0, scale: 1 };
    const point = pointerEventToCanvasPoint(60, 120, camera, svg);
    expect(point).toEqual({ x: 50, y: 100 });
  });

  it('rgbToCss converts rgb to hex string', () => {
    expect(rgbToCss({ r: 255, g: 0, b: 127 })).toBe('#ff007f');
  });

  it('resizeBounds updates rectangle based on corner', () => {
    const orig = { x: 0, y: 0, width: 100, height: 100 };
    const resized = resizeBounds(orig, side.bottom | side.right, { x: 150, y: 150 });
    expect(resized).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it('pickLayersInBox returns ids within area', () => {
    const layers = new Map([
      ['a', { x:0, y:0, width:10, height:10 } as any],
      ['b', { x:5, y:5, width:10, height:10 } as any],
    ]);
    const ids = pickLayersInBox(['a','b'], layers, {x:0,y:0}, {x:15,y:15});
    expect(ids).toEqual(['a','b']);
  });

  it('getContrastingTextColor chooses readable color', () => {
    expect(getContrastingTextColor({ r:255, g:255, b:255 })).toBe('black');
    expect(getContrastingTextColor({ r:0, g:0, b:0 })).toBe('white');
  });

  it('measureText returns width for text', () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ({
      font: '',
      measureText: () => ({ width: 42 })
    }) as any;
    const width = measureText('hello', 16);
    expect(width).toBe(42);
    HTMLCanvasElement.prototype.getContext = original;
  });

  it('makePathLayer builds path layer from points', () => {
    const layer = makePathLayer([[0,0],[10,0]], { r:0,g:0,b:0 }, 2);
    expect(layer.type).toBe(LayerType.Path);
    expect(layer.width).toBeGreaterThan(0);
  });

  it('convertPointsToPath creates svg path string', () => {
    const str = convertPointsToPath([[0,0],[10,0],[10,10]]);
    expect(str.startsWith('M')).toBe(true);
  });

  it('isPointNearBoundingBox detects proximity', () => {
    const box = { x:0, y:0, width:100, height:100 };
    expect(isPointNearBoundingBox({x:2, y:2}, box)).toBe(true);
    expect(isPointNearBoundingBox({x:-10, y:-10}, box)).toBe(false);
  });

  it('doesPointIntersectPath detects intersection', () => {
  const layer: PathLayer = { type: LayerType.Path, x:0, y:0, width:10, height:10, fill:{r:0,g:0,b:0}, points:[[0,0],[10,0],[10,10]] };
  expect(doesPointIntersectPath({x:5,y:0}, layer)).toBe(true);
  expect(doesPointIntersectPath({x:50,y:50}, layer)).toBe(false);
});

  it('getLayerBounds extracts numeric bounds', () => {
    const live = new LiveObject<Layer>({
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        type: LayerType.Path,
        fill: { r: 0, g: 0, b: 0 },
        points: [[0, 0], [10, 10]]
    });
    expect(getLayerBounds(live)).toEqual({ x:1, y:2, width:3, height:4 });
  });
});