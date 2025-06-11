import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getImageDimensions } from '../lib/utils';

let originalImage: typeof Image;
let mockInstance: any;

class MockImage {
  onload: ((this: any, ev?: any) => any) | null = null;
  onerror: ((this: any, ev?: any) => any) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  _src = '';
  constructor() {
    mockInstance = this;
  }
  set src(value: string) {
    this._src = value;
  }
  get src() {
    return this._src;
  }
}

describe('getImageDimensions', () => {
  beforeEach(() => {
    mockInstance = null;
    originalImage = (global as any).Image;
    (global as any).Image = MockImage as unknown as typeof Image;
  });

  afterEach(() => {
    (global as any).Image = originalImage;
  });

  it('resolves with width and height when onload fires', async () => {
    const promise = getImageDimensions('http://example.com/img.png');
    mockInstance.naturalWidth = 123;
    mockInstance.naturalHeight = 456;
    mockInstance.onload && mockInstance.onload(new Event('load'));
    await expect(promise).resolves.toEqual({ width: 123, height: 456 });
  });

  it('rejects when onerror fires', async () => {
    const promise = getImageDimensions('http://example.com/img.png');
    mockInstance.onerror && mockInstance.onerror(new Error('fail'));
    await expect(promise).rejects.toBeInstanceOf(Error);
  });
});