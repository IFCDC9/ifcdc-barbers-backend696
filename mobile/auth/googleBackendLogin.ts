import { fetchWithTimeout, mapAuthErrorToMessage, type JsonAuth } from "./authSessionApi";

export type GoogleAuthUser = NonNullable<JsonAuth["user"]>;

type GoogleAuthJson = {
  ok?: boolean;
  /** Some gateways / older handlers use `success` instead of `ok`. */
  success?: boolean;
  token?: string;
  accessToken?: string;
  user?: GoogleAuthUser;
  redirect?: string;
  error?: string;
  detail?: string;
};

export type GoogleExchangeResult = {
  token?: string;
  user?: GoogleAuthUser;
  redirect?: string;
};

/**
 * POST id_token to the API. Use AbortSignal to avoid duplicate work under React Strict Mode.
 */
export async function exchangeGoogleIdToken(
  backendBaseUrl: string,
  idToken: string,
  signal?: AbortSignal
): Promise<GoogleExchangeResult> {
  const trimmed = idToken.trim();
  if (!trimmed) {
    throw new Error("idToken_empty");
  }

  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[auth/google] POST /api/auth/google", { idTokenLength: trimmed.length });
  }

  const url = `${backendBaseUrl.replace(/\/$/, "")}/api/auth/google`;
  console.log("[auth/google] POST", url);

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ idToken: trimmed }),
      signal,
      timeoutMs: 28_000,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      console.error("[auth] FAIL", { method: "POST", url, status: "TIMEOUT", responseCode: 0 });
      throw new Error(`Request timed out after 28s. Endpoint: ${url}`);
    }
    console.error("[auth] FAIL", { method: "POST", url, status: "NETWORK", responseCode: 0 });
    throw new Error(mapAuthErrorToMessage(null, 0));
  }

  const text = await res.text();
  let json: GoogleAuthJson = {};
  try {
    json = text ? (JSON.parse(text) as GoogleAuthJson) : {};
  } catch {
    throw new Error(
      `Server did not return JSON (${res.status}). Is BACKEND_URL correct? (${url.slice(0, 48)}…)`
    );
  }

  console.log("[auth/google] response", { status: res.status, ok: res.ok, keys: Object.keys(json) });

  const hasTok = Boolean([json.token, json.accessToken].find((t) => typeof t === "string" && t.trim()));
  if (!res.ok || !hasTok || json.error) {
    throw new Error(mapAuthErrorToMessage(json as unknown as JsonAuth, res.status));
  }

  const token = [json.token, json.accessToken].find(
    (t) => typeof t === "string" && t.trim().length > 0
  )?.trim();

  return { token, user: json.user, redirect: json.redirect };
}
