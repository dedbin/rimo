"use client";

import { useCallback, useState } from "react";

export function useApiMutation<TPayload, TResult>(
  mutation: (payload: TPayload) => Promise<TResult>,
) {
  const [pendingCount, setPendingCount] = useState(0);
  const mutate = useCallback(async (payload: TPayload): Promise<TResult> => {
    setPendingCount((count) => count + 1);
    try {
      return await mutation(payload);
    } finally {
      setPendingCount((count) => Math.max(0, count - 1));
    }
  }, [mutation]);
  return { mutate, pending: pendingCount > 0 };
}
