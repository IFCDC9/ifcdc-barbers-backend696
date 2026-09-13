import { apiFullUrl } from "../constants/config";
import { getSupabase } from "../lib/supabase";

export type EnsureSupabaseAuthResult =
  | { ok: true; mode: "existing" | "bridge" | "anonymous" | "skipped" }
  | { ok: false; message: string };

/**
 * Optional Realtime/Storage helper — NOT used for IFCDC login.
 * App authentication is custom JWT + app_users via the Node API.
 * Do not call supabase.auth.signIn* for manager/customer login.
 */
export async function ensureSupabaseAuth(appJwt: string | null): Promise<EnsureSupabaseAuthResult> {
  const sb = getSupabase();
  if (!sb) {
    return { ok: true, mode: "skipped" };
  }

  const { data: sessionData } = await sb.auth.getSession();
  if (sessionData.session?.user) {
    return { ok: true, mode: "existing" };
  }

  const bridgeEnabled = process.env.EXPO_PUBLIC_ENABLE_SUPABASE_AUTH_BRIDGE === "1";
  if (!bridgeEnabled) {
    return { ok: true, mode: "skipped" };
  }

  if (appJwt) {
    try {
      const res = await fetch(apiFullUrl("/api/auth/supabase-bridge"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt}`,
          "Content-Type": "application/json",
        },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        supabase?: { email?: string; password?: string };
        error?: string;
        detail?: string;
      };
      if (res.ok && json?.ok && json.supabase?.email && json.supabase?.password) {
        const { error } = await sb.auth.signInWithPassword({
          email: json.supabase.email,
          password: json.supabase.password,
        });
        if (!error) {
          return { ok: true, mode: "bridge" };
        }
      }
    } catch {
      /* optional storage session only */
    }
  }

  return {
    ok: true,
    mode: "skipped",
  };
}
