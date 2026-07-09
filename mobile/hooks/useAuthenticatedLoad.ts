import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useAuth } from "../services/authContext";
import { getAuthToken } from "../services/authService";
import { isSessionExpiredError } from "../services/sessionApi";
import { userFacingApiError } from "../utils/userFacingApiError";

type LoadState = {
  loading: boolean;
  error: string | null;
  needsSignIn: boolean;
  loadedOnce: boolean;
};

/**
 * Load protected data — uses SecureStore token directly, never blocks on /me bootstrap.
 */
export function useAuthenticatedLoad(
  loadFn: () => Promise<void>,
  deps: React.DependencyList = [],
) {
  const { token: contextToken } = useAuth();
  const [state, setState] = useState<LoadState>({
    loading: true,
    error: null,
    needsSignIn: false,
    loadedOnce: false,
  });
  const loadRef = useRef(loadFn);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  loadRef.current = loadFn;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const run = useCallback(async (opts: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    const silent = opts.silent === true;

    if (!silent) {
      setState((prev) => ({
        ...prev,
        loading: !prev.loadedOnce,
        error: null,
      }));
    }

    const bearer = contextToken || (await getAuthToken());
    if (!bearer) {
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      setState({ loading: false, error: null, needsSignIn: true, loadedOnce: false });
      return;
    }

    try {
      await loadRef.current();
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      setState({ loading: false, error: null, needsSignIn: false, loadedOnce: true });
    } catch (e) {
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      if (isSessionExpiredError(e)) {
        setState({
          loading: false,
          error: "Session expired. Sign out and sign in again.",
          needsSignIn: true,
          loadedOnce: false,
        });
        return;
      }
      setState((prev) => ({
        loading: false,
        error: userFacingApiError(e),
        needsSignIn: false,
        loadedOnce: prev.loadedOnce,
      }));
    }
  }, [contextToken]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, contextToken, ...deps]);

  useFocusEffect(
    useCallback(() => {
      if (state.loadedOnce) void run({ silent: true });
    }, [run, state.loadedOnce]),
  );

  const reload = useCallback(async () => {
    await run({ silent: false });
  }, [run]);

  return { ...state, reload };
}
