"use client";

import { mutate } from "swr";
import type { BoardSummary } from "@/types/service";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let message = "Не удалось выполнить запрос";
    if (data && typeof data === "object" && "error" in data) {
      if (typeof data.error === "string") message = data.error;
      else if (data.error && typeof data.error === "object" && "message" in data.error &&
        typeof data.error.message === "string") message = data.error.message;
    }
    throw new ApiError(message, response.status);
  }
  return data as T;
}

async function refreshBoards(): Promise<void> {
  await mutate((key) => typeof key === "string" &&
    (key === "/api/boards" || key.startsWith("/api/boards?") ||
      /^\/api\/boards\/[^/]+$/.test(key)));
}

export const boardApi = {
  async create({ title }: { title: string }): Promise<BoardSummary> {
    const { board } = await requestJson<{ board: BoardSummary }>("/api/boards", {
      method: "POST", body: JSON.stringify({ title }),
    });
    await refreshBoards();
    return board;
  },
  async rename({ id, title }: { id: string; title: string }): Promise<void> {
    await requestJson(`/api/boards/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ title }),
    });
    await refreshBoards();
  },
  async remove({ id }: { id: string }): Promise<void> {
    await requestJson(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshBoards();
  },
  async favorite({ id, favorite }: { id: string; favorite: boolean }): Promise<void> {
    await requestJson(`/api/boards/${encodeURIComponent(id)}/favorite`, {
      method: favorite ? "PUT" : "DELETE",
    });
    await refreshBoards();
  },
};
