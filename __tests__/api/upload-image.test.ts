import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/upload-image/route';
import { api } from '@/convex/_generated/api';

const queryMock = vi.fn();
const actionMock = vi.fn();
const mutationMock = vi.fn();

vi.mock('convex/browser', () => ({
  ConvexHttpClient: vi.fn(() => ({
    query: queryMock,
    action: actionMock,
    mutation: mutationMock,
  })),
}));

describe('POST /api/upload-image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

function makeRequest() {
    const file = {
      arrayBuffer: async () => Buffer.from('data'),
      type: 'image/png',
    } as unknown as File;
    const formData = {
      get: (name: string) => (name === 'file' ? file : null),
    } as unknown as FormData;
    return { file, formData, req: { formData: async () => formData } as unknown as NextRequest };
  }

  it('uploads new image and stores it', async () => {
    const { req } = makeRequest();
    queryMock.mockResolvedValueOnce(null);
    actionMock.mockResolvedValueOnce('http://upload.url');
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ storageId: 's1' }) } as any);
    mutationMock.mockResolvedValueOnce({ url: 'http://file/s1' });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'http://file/s1' });
    expect(queryMock).toHaveBeenCalledWith(api.images.getBySha, { sha256: expect.any(String) });
    expect(actionMock).toHaveBeenCalledWith(api.images.generateUploadUrl, {});
    expect(fetchMock).toHaveBeenCalledWith('http://upload.url', expect.objectContaining({ method: 'POST' }));
    expect(mutationMock).toHaveBeenCalledWith(api.images.saveImage, {
      sha256: expect.any(String),
      storageId: 's1',
    });

    fetchMock.mockRestore();
  });

  it('does not duplicate when uploading same file twice', async () => {
    const { req } = makeRequest();
    queryMock.mockResolvedValueOnce(null);
    actionMock.mockResolvedValueOnce('http://upload.url');
    const fetchMock1 = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ storageId: 's1' }) } as any);
    mutationMock.mockResolvedValueOnce({ url: 'http://file/s1' });

    const res1 = await POST(req);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ url: 'http://file/s1' });
    const firstSha = queryMock.mock.calls[0][1].sha256;
    fetchMock1.mockRestore();

    queryMock.mockResolvedValueOnce({ url: 'http://file/s1' });
    const fetchMock2 = vi.spyOn(global, 'fetch');

    const res2 = await POST(req);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ url: 'http://file/s1' });
    expect(queryMock).toHaveBeenCalledTimes(2);
    const secondSha = queryMock.mock.calls[1][1].sha256;
    expect(secondSha).toBe(firstSha);
    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(fetchMock2).not.toHaveBeenCalled();

    fetchMock2.mockRestore();
  });
});