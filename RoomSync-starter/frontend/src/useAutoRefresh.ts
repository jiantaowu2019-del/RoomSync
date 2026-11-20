import { useCallback, useEffect, useRef } from "react";

const REFRESH_INTERVAL_MS = 12_000;

export function useAutoRefresh(refresh: (signal: AbortSignal) => Promise<void>, enabled: boolean) {
  const active = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) return;

    async function refreshVisiblePage() {
      if (document.visibilityState !== "visible" || active.current) return;
      const request = new AbortController();
      active.current = request;
      try {
        await refresh(request.signal);
      } catch {
        // Retry transient failures on the next foreground refresh.
        request.abort();
      } finally {
        if (active.current === request) active.current = null;
      }
    }

    const timer = window.setInterval(refreshVisiblePage, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshVisiblePage);
    window.addEventListener("pageshow", refreshVisiblePage);
    document.addEventListener("visibilitychange", refreshVisiblePage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisiblePage);
      window.removeEventListener("pageshow", refreshVisiblePage);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
      cancel();
    };
  }, [enabled, refresh, cancel]);

  return cancel;
}
