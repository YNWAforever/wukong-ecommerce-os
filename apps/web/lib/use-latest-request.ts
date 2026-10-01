"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supportRequestId } from "./support-request-id";
export type LatestRequestState<T> = {
  data: T | null;
  error: string | null;
  supportId?: string;
  loading: boolean;
  stale: boolean;
  reload: () => void;
};
export function useLatestRequest<T>(
  load: (signal: AbortSignal) => Promise<T>,
  errorFallback: string,
): LatestRequestState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supportId, setSupportId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal)
      .then((next) => {
        if (requestId.current !== id) return;
        setData(next);
        setError(null);
        setSupportId(undefined);
      })
      .catch((cause: unknown) => {
        if (requestId.current !== id || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : errorFallback);
        setSupportId(
          supportRequestId(
            cause instanceof Error
              ? (cause as Error & { requestId?: unknown }).requestId
              : undefined,
          ),
        );
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
    return () => {
      ++requestId.current;
      controller.abort();
    };
  }, [load, errorFallback, revision]);
  return {
    data,
    error,
    supportId,
    loading,
    stale: loading && data !== null,
    reload,
  };
}
