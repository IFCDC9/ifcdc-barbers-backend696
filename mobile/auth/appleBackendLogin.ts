import { fetchWithTimeout, mapAuthErrorToMessage, type JsonAuth } from "./authSessionApi";

export type AppleAuthUser = {
  id?: string;
  name?: string | null;
  email?: string;
  role?: string;
  isOwner?: boolean;
  isSuperAdmin?: boolean;
};

type AppleAuthJson = {
  ok?: boolean;
  success?: boolean;
  token?: string;
  accessToken?: string;
  user?: AppleAuthUser;
  redirect?: string;
  error?: string;
  message?: string;
  detail?: string;
};

export type AppleExchangeResult = {
  token?: string;
  user?: AppleAuthUser;
  redirect?: string;
};

export async function exchangeAppleIdentityToken(
  backendBaseUrl: string,
  identityToken: string,
  options?: { email?: string | null; fullName?: string | null; signal?: AbortSignal },
): Promise<AppleExchangeResult> {
  const trimmed = identityToken.trim();
  if (!trimmed) throw new Error("identityToken_empty");

  const url = `${backendBaseUrl.replace(/\/$/, "")}/api/auth/apple`;
  console.log("[auth/apple] POST", url);

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        identityToken: trimmed,
        email: options?.email?.trim() || undefined,
        fullName: options?.fullName?.trim() || undefined,
      }),
      signal: options?.signal,
      timeoutMs: 28_000,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      throw new Error(`Request timed out after 28s. Endpoint: ${url}`);
    }
    throw new Error(mapAuthErrorToMessage(null, 0));
  }

  const text = await res.text();
  let json: AppleAuthJson = {};
  try {
    json = text ? (JSON.parse(text) as AppleAuthJson) : {};
  } catch {
    throw new Error(
      `Server did not return JSON (${res.status}). Is BACKEND_URL correct? (${url.slice(0, 48)}…)`,
    );
  }

  console.log("[auth/apple] response", { status: res.status, ok: res.ok, keys: Object.keys(json) });

  const hasTok = Boolean([json.token, json.accessToken].find((t) => typeof t === "string" && t.trim()));
  if (!res.ok || !hasTok || json.error) {
    throw new Error(mapAuthErrorToMessage(json as unknown as JsonAuth, res.status));
  }

  const token = [json.token, json.accessToken].find(
    (t) => typeof t === "string" && t.trim().length > 0,
  )?.trim();

  return { token, user: json.user, redirect: json.redirect };
}
