import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../services/authContext";
import { getAuthToken } from "../services/authService";
import { isSessionExpiredError } from "../services/sessionApi";
import { userFacingApiError } from "../utils/userFacingApiError";

type LoadState = {
  loading: boolean;
  error: string | null;
  needsSignIn: boolean;
};

const AUTH_BOOTSTRAP_TIMEOUT_MS = 20_000;

/**
 * Run a protected API load only after auth bootstrap finishes and a JWT is present.
 * Falls back to SecureStore when context token lags behind persisted session.
 */
export function useAuthenticatedLoad(
  loadFn: () => Promise<void>,
  deps: React.DependencyList = [],
) {
  const { loading: authLoading, token: contextToken, signOut } = useAuth();
  const [state, setState] = useState<LoadState>({ loading: true, error: null, needsSignIn: false });
  const [authTimedOut, setAuthTimedOut] = useState(false);
  const loadRef = useRef(loadFn);
  loadRef.current = loadFn;

  useEffect(() => {
    if (!authLoading) {
      setAuthTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setAuthTimedOut(true), AUTH_BOOTSTRAP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [authLoading]);

  const waitingOnAuth = authLoading && !authTimedOut;

  const run = useCallback(async () => {
    if (waitingOnAuth) return;

    const bearer = contextToken || (await getAuthToken());
    if (!bearer) {
      setState({ loading: false, error: null, needsSignIn: true });
      return;
    }

    setState({ loading: true, error: null, needsSignIn: false });
    try {
      await loadRef.current();
      setState({ loading: false, error: null, needsSignIn: false });
    } catch (e) {
      if (isSessionExpiredError(e)) {
        await signOut();
        setState({ loading: false, error: "Session expired. Sign in again.", needsSignIn: true });
        return;
      }
      setState({
        loading: false,
        error: userFacingApiError(e),
        needsSignIn: false,
      });
    }
  }, [waitingOnAuth, contextToken, signOut]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, waitingOnAuth, contextToken, ...deps]);

  return { ...state, reload: run };
}
