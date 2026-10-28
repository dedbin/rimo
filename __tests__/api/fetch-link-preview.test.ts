import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
    const network = vi.spyOn(globalThis, 'fetch');
    const req = new NextRequest('http://localhost/api/fetch-link-preview?url=https://example.com');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      title: 'example.com',
      description: 'https://example.com/'
    });
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });

  it('rejects executable URLs', async () => {
    const req = new NextRequest('http://localhost/api/fetch-link-preview?url=javascript:alert(1)');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid URL');
  });
});
