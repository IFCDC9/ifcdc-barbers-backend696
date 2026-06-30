import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

const DEFAULT_INTERVAL_MS = 30_000;

/** Poll + refetch when the app returns to foreground. */
export function useLiveSlotRefresh(onRefresh: () => void, enabled: boolean, intervalMs = DEFAULT_INTERVAL_MS) {
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

    const onAppState = (state: AppStateStatus) => {
      if (state === "active") tick();
    };

    const sub = AppState.addEventListener("change", onAppState);
    const id = setInterval(tick, intervalMs);
    return () => {
      sub.remove();
      clearInterval(id);
    };
  }, [enabled, intervalMs]);
}
