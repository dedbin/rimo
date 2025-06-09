import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/generate-cover/route';

describe('POST /api/generate-cover', () => {
  it('returns id and image url', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBeTruthy();
    expect(json.imageUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});