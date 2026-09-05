"use client";
import { useCallback, useEffect, useRef, useState } from "react";
export type LatestRequestState<T> = {
  data: T | null;
  error: string | null;
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
      })
      .catch((cause: unknown) => {
        if (requestId.current !== id || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : errorFallback);
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
    return () => {
      ++requestId.current;
      controller.abort();
    };
  }, [load, errorFallback, revision]);
  return { data, error, loading, stale: loading && data !== null, reload };
}
