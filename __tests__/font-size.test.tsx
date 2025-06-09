import { describe, it, expect, vi } from 'vitest';
import { createLayer } from '@/app/board/[boardId]/_components/canvas';
import { LayerType, TextLayer, StickerLayer, Color } from '@/types/board-canvas';

const pos = { x: 0, y: 0 };
const color: Color = { r: 0, g: 0, b: 0 };

vi.mock('next/font/google', () => ({ Poppins: () => ({ className: 'poppins' }) }));
describe('font size behavior', () => {
  it('createLayer provides default fontSize', () => {
    const text = createLayer(LayerType.Text, pos, color).toImmutable() as TextLayer;
    const sticker = createLayer(LayerType.Sticker, pos, color).toImmutable() as StickerLayer;
    expect(text.fontSize).toBe(16);
    expect(sticker.fontSize).toBe(16);
  });
});