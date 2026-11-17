"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Data from the API for a screen. Loads when the fetcher changes (pass a
 * stable one from useCallback) and again whenever reload() is awaited.
 */
export function useLoaded<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    fetcher().then(
      (value) => {
        if (!live) return;
        setData(value);
        setError(null);
      },
      (failure: unknown) => {
        if (live) setError(failure);
      },
    );
    return () => {
      live = false;
    };
  }, [fetcher]);

  const reload = useCallback(async () => {
    try {
      setData(await fetcher());
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }, [fetcher]);

  return { data, error, reload };
}
