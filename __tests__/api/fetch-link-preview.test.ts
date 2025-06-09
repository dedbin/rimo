/// <reference types="vitest" />
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('link-preview-js', () => ({
  getLinkPreview: vi.fn()
}));

import { getLinkPreview } from 'link-preview-js';
import { GET } from '@/app/api/fetch-link-preview/route';

describe('GET /api/fetch-link-preview', () => {
  it('returns 400 when url is missing', async () => {
    const req = new NextRequest('http://localhost/api/fetch-link-preview');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('No URL');
  });

  it('returns preview data', async () => {
    (getLinkPreview as unknown as vi.Mock).mockResolvedValue({
      title: 'Title',
      description: 'Desc',
      images: ['img.png'],
      favicons: ['fav.ico']
    });
    const req = new NextRequest('http://localhost/api/fetch-link-preview?url=https://example.com');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      title: 'Title',
      description: 'Desc',
      image: 'img.png',
      favicon: 'fav.ico'
    });
    expect(getLinkPreview).toHaveBeenCalledWith('https://example.com');
  });

  it('handles errors from getLinkPreview', async () => {
    (getLinkPreview as unknown as vi.Mock).mockRejectedValue(new Error('fail'));
    const req = new NextRequest('http://localhost/api/fetch-link-preview?url=https://example.com');
    const res = await GET(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Failed to fetch link preview');
  });
});