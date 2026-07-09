import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../services/authContext";
import { isSessionExpiredError } from "../services/sessionApi";

type LoadState = {
  loading: boolean;
  error: string | null;
  needsSignIn: boolean;
};

/**
 * Run a protected API load only after auth bootstrap finishes and a JWT is present.
 * Clears session automatically when the API reports 401.
 */
export function useAuthenticatedLoad(
  loadFn: () => Promise<void>,
  deps: React.DependencyList = [],
) {
  const { loading: authLoading, token, signOut } = useAuth();
  const [state, setState] = useState<LoadState>({ loading: true, error: null, needsSignIn: false });
  const loadRef = useRef(loadFn);
  loadRef.current = loadFn;

  const run = useCallback(async () => {
    if (authLoading) return;
    if (!token) {
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
      const message = e instanceof Error ? e.message : "Something went wrong.";
      setState({ loading: false, error: message, needsSignIn: false });
    }
  }, [authLoading, token, signOut]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, authLoading, token, ...deps]);

  return { ...state, reload: run };
}
