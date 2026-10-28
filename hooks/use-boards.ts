"use client";

import useSWR from "swr";
import { requestJson } from "@/lib/api-client";
import type { BoardSummary } from "@/types/service";

export function useBoards(query: { search?: string; favorites?: string } = {}) {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.favorites) params.set("favorites", "1");
  const key = `/api/boards${params.size ? `?${params}` : ""}`;
  const result = useSWR(key, requestJson<{ boards: BoardSummary[] }>, {
    keepPreviousData: true,
  });
  return { ...result, boards: result.data?.boards };
}
