import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getImageDimensions } from '../lib/utils';

let image: HTMLImageElement;

describe('getImageDimensions', () => {
  beforeEach(() => {
    image = document.createElement('img');
    vi.stubGlobal('Image', class { constructor() { return image; } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with width and height when onload fires', async () => {
    const promise = getImageDimensions('http://example.com/img.png');
    Object.defineProperty(image, 'naturalWidth', { value: 123 });
    Object.defineProperty(image, 'naturalHeight', { value: 456 });
    image.dispatchEvent(new Event('load'));
    await expect(promise).resolves.toEqual({ width: 123, height: 456 });
  });

  it('rejects when onerror fires', async () => {
    const promise = getImageDimensions('http://example.com/img.png');
    image.dispatchEvent(new Event('error'));
    await expect(promise).rejects.toBeInstanceOf(Event);
  });
});
