import { useEffect, useRef } from "react";

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Poll + refetch when the tab becomes visible (keeps slot pickers fresh after admin changes).
 */
export function useLiveSlotRefresh(onRefresh, enabled, intervalMs = DEFAULT_INTERVAL_MS) {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return undefined;

    const tick = () => {
      try {
        onRefreshRef.current?.();
      } catch {
        // ignore
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    const id = window.setInterval(tick, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(id);
    };
  }, [enabled, intervalMs]);
}
