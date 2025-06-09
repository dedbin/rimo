import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { FormData, File } from 'undici';

(global as any).File = File as unknown as typeof global.File;
(global as any).FormData = FormData as unknown as typeof global.FormData;

vi.mock('fs/promises', () => {
  const writeFile = vi.fn();
  const mkdir = vi.fn();
  return {
    writeFile,
    mkdir,
    default: { writeFile, mkdir },
  };
});
vi.mock('fs', () => {
  const existsSync = vi.fn(() => true);
  return {
    existsSync,
    default: { existsSync },
  };
});
vi.mock('nanoid', () => ({
  nanoid: () => 'abc123',
}));

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { POST } from '@/app/api/upload-image/route';

describe('POST /api/upload-image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when file missing', async () => {
    const formData = new FormData();
    const req = { formData: async () => formData } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No file provided' });
  });

  it('returns 400 for invalid file type', async () => {
    const formData = new FormData();
    formData.append('file', new File(['hello'], 'file.txt', { type: 'text/plain' }));
    const req = { formData: async () => formData } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are supported' });
  });

});