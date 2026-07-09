import React from "react";
import { signOutSupabase } from "../lib/supabase";
import { decodeJwtPayload, isOwnerAdminDashboardPayload } from "../auth/jwtSession";
import { getAuthMe, type JsonAuth } from "../auth/authSessionApi";
import { getAuthToken, setAuthToken, subscribeAuthToken } from "./authService";
import { refreshAuthSession } from "./sessionApi";
import { isSuperAdminUser } from "../utils/adminAccess";
import { hasStaffDashboardAccess, resolveStaffRole } from "../utils/staffDashboardAccess";

export type SessionKind = "owner" | "default";

export type AppUser = NonNullable<JsonAuth["user"]>;

type AuthContextValue = {
  loading: boolean;
  token: string | null;
  user: AppUser | null;
  sessionKind: SessionKind;
  isPlatformAdmin: boolean;
  hasStaffDashboard: boolean;
  staffRole: ReturnType<typeof resolveStaffRole>;
  approvalPending: boolean;
  signInWithToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

function tokenToSessionKind(t: string | null): SessionKind {
  if (!t) return "default";
  const payload = decodeJwtPayload(t);
  return isOwnerAdminDashboardPayload(payload) ? "owner" : "default";
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = React.useState(true);
  const [token, setToken] = React.useState<string | null>(null);
  const [user, setUser] = React.useState<AppUser | null>(null);
  const [sessionKind, setSessionKind] = React.useState<SessionKind>("default");

  const applySession = React.useCallback((t: string | null, u: AppUser | null) => {
    setToken(t);
    setUser(u);
    setSessionKind(tokenToSessionKind(t));
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const t = await getAuthToken();
      if (!t) {
        applySession(null, null);
        return;
      }
      const me = await getAuthMe(t, 15_000);
      if (!me.ok) {
        if (me.status === 401 || me.status === 403) {
          const refreshed = await refreshAuthSession(t);
          if (refreshed?.token) {
            await setAuthToken(refreshed.token);
            applySession(refreshed.token, refreshed.user ?? null);
            return;
          }
          console.warn("[auth] stored session rejected; clearing token", { status: me.status, url: me.url });
          await setAuthToken(null);
          applySession(null, null);
          return;
        }
        if (me.status === 404) {
          console.warn("[auth] GET /api/auth/me missing on server — using JWT until API is deployed", { url: me.url });
          applySession(t, null);
          return;
        }
        if (me.status === 0) {
          console.warn("[auth] /me unreachable (network/timeout); keeping cached JWT", { url: me.url });
          applySession(t, null);
          return;
        }
        console.warn("[auth] /me unexpected status; keeping cached JWT", { status: me.status, url: me.url });
        applySession(t, null);
        return;
      }
      applySession(t, me.json.user ?? null);
      if (me.json.token) {
        const fresh = String(me.json.token).trim();
        await setAuthToken(fresh);
        setToken(fresh);
      }
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    return subscribeAuthToken((t) => {
      setToken((prev) => (prev === t ? prev : t));
    });
  }, []);

  const signInWithToken = React.useCallback(async (t: string) => {
    try {
      await setAuthToken(t);
      const me = await getAuthMe(t, 15_000);
      if (me.ok && me.json.token) {
        const fresh = String(me.json.token).trim();
        await setAuthToken(fresh);
        applySession(fresh, me.json.user ?? null);
      } else {
        applySession(t, me.ok ? me.json.user ?? null : null);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.error("[auth] SecureStore setItemAsync failed:", raw);
      const hint =
        /user_cancel|UserCancel|cancel/i.test(raw)
          ? "Sign-in was cancelled before the session could be saved."
          : "Token save failed. Try again, restart the app, or check device storage / Screen Time restrictions.";
      throw new Error(hint);
    }
  }, [applySession]);

  const signOut = React.useCallback(async () => {
    await signOutSupabase();
    await setAuthToken(null);
    applySession(null, null);
  }, [applySession]);

  const isPlatformAdmin = isSuperAdminUser(user, token);
  const staffRole = resolveStaffRole(user, token);
  const hasStaffDashboard = hasStaffDashboardAccess(user, token);
  const approvalPending = user?.limitedAccess === true;

  const value: AuthContextValue = {
    loading,
    token,
    user,
    sessionKind,
    isPlatformAdmin,
    hasStaffDashboard,
    staffRole,
    approvalPending,
    signInWithToken,
    signOut,
    refresh,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
