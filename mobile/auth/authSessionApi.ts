import { apiFullUrl, BACKEND_URL } from "../constants/config";
import { UX } from "../utils/uxCopy";

export type JsonAuth = {
  ok?: boolean;
  success?: boolean;
  token?: string;
  user?: {
    id?: string;
    name?: string;
    email?: string;
    phone?: string | null;
    profileImageUrl?: string | null;
    role?: string;
    isOwner?: boolean;
    isSuperAdmin?: boolean;
    createdAt?: string | null;
    businessId?: number | null;
    barberId?: number | null;
    preferredLanguage?: string | null;
    preferred_language?: string | null;
    language?: string | null;
    approvalStatus?: string;
    limitedAccess?: boolean;
    message?: string;
  };
  redirect?: string;
  approvalPending?: boolean;
  error?: string;
  message?: string;
  detail?: string;
};

const DEFAULT_AUTH_TIMEOUT_MS = 20_000;

function clip(s: string, max: number) {
  const t = String(s || "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Fetch with wall-clock timeout; aborts if `userSignal` fires or timeout elapses. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_AUTH_TIMEOUT_MS, signal: userSignal, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onUserAbort = () => ctrl.abort();
  if (userSignal) userSignal.addEventListener("abort", onUserAbort);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
  }
}

export function loginResponseSucceeded(status: number, json: JsonAuth | null): boolean {
  if (!json || status < 200 || status >= 300) return false;
  const tok = String(json.token || "").trim();
  if (!tok) return false;
  if (json.ok === false || json.success === false) return false;
  return json.ok === true || json.success === true || Boolean(json.token);
}

/** Maps backend `error` codes and HTTP status to user-facing copy. */
export function mapAuthErrorToMessage(json: JsonAuth | null, status: number): string {
  const code = String(json?.error || "").trim();
  const msg = String(json?.message || "").trim();
  const detail = String(json?.detail || "").trim();

  if (status === 0 || Number.isNaN(status)) {
    return UX.errorConnection;
  }

  if (code === "user_not_found") return msg || "No account exists for this email.";
  if (code === "invalid_password") return msg || "Wrong password.";
  if (code === "invalid_login") return msg || "Invalid email or password.";
  if (code === "missing_credentials") return msg || "Enter your email and password.";

  if (code === "forbidden_role") return msg || "That account type cannot be created here.";
  if (code === "invalid_role") return msg || "Choose a valid account type.";

  if (code === "google_oauth_not_configured") {
    return "Google sign-in is not available right now. Please sign in with email or contact support.";
  }
  if (code === "google_audience_mismatch") {
    return msg || "Google sign-in could not be verified. Please try again.";
  }
  if (code === "google_token_invalid") return msg || "Google could not verify this sign-in. Try again.";
  if (code === "google_verify_unreachable") return msg || "Could not reach Google. Check your connection.";
  if (code === "google_account_conflict") return msg || "This email is linked to a different Google account.";
  if (code === "google_email_unverified") return msg || "Verify this email in Google, then try again.";
  if (code === "google_payload_invalid") return msg || "Google did not return enough profile data.";

  if (code === "apple_token_invalid") return msg || "Apple could not verify this sign-in. Try again.";
  if (code === "apple_email_required") {
    return msg || "Apple did not share an email. Choose Share My Email on the Apple prompt.";
  }
  if (code === "apple_account_conflict") return msg || "This email is linked to a different Apple ID.";
  if (code === "apple_email_unverified") return msg || "Verify this email in your Apple ID, then try again.";
  if (code === "apple_payload_invalid") return msg || "Apple did not return enough profile data.";

  if (code === "account_protected") return msg || "This account cannot be deleted from the app.";
  if (code === "user_not_found" && status === 400) return msg || "Account not found.";

  if (code === "email_exists" || status === 409) return msg || "This email is already registered. Try signing in.";
  if (code === "weak_password") return msg || "Password is too weak.";
  if (code === "name_required") return msg || "Name is required.";
  if (code === "phone_required") return msg || "Phone number is required.";
  if (code === "phone_invalid") return msg || "Enter a valid 10-digit phone number.";
  if (code === "shop_name_required" || code === "business_name_required") return msg || "Shop name is required.";
  if (code === "address_required") return msg || "Shop address is required.";
  if (code === "city_required") return msg || "City is required.";
  if (code === "state_required") return msg || "State is required.";
  if (code === "location_required") return msg || "Location is required.";
  if (code === "email_failed" || code === "email_unconfigured") {
    return msg || "Could not send reset email. Please try again later.";
  }
  if (code === "invalid_token" || code === "token_expired") {
    return msg || "This reset link is invalid or expired. Request a new one.";
  }

  if (status >= 500) return msg || UX.errorGeneric;
  if (msg) return detail ? `${msg} ${detail}` : msg;
  if (detail) return detail;
  return UX.errorGeneric;
}

export async function postAuthJson(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_AUTH_TIMEOUT_MS,
): Promise<{ json: JsonAuth; status: number; raw: string; url: string }> {
  const url = apiFullUrl(path);
  console.log("[auth] POST", url, { bodyKeys: Object.keys(body), BACKEND_URL });

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal,
      timeoutMs,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const m = e instanceof Error ? e.message : String(e);
    if (name === "AbortError") {
      console.error("[auth] FAIL", { method: "POST", url, status: "TIMEOUT", responseCode: 0, message: m });
      throw new Error(UX.errorConnection);
    }
    console.error("[auth] FAIL", { method: "POST", url, status: "NETWORK", responseCode: 0, message: m });
    throw new Error(mapAuthErrorToMessage(null, 0));
  }

  const raw = await res.text();
  console.log("[auth] response", { url, status: res.status, body: clip(raw, 1200) });

  let json: JsonAuth = {};
  try {
    json = raw ? (JSON.parse(raw) as JsonAuth) : {};
  } catch {
    console.error("[auth] FAIL", {
      method: "POST",
      url,
      status: "NON_JSON",
      responseCode: res.status,
      body: clip(raw, 400),
    });
    throw new Error(UX.errorGeneric);
  }

  if (!loginResponseSucceeded(res.status, json)) {
    console.warn("[auth] FAIL", {
      method: "POST",
      url,
      responseCode: res.status,
      error: json?.error,
      message: clip(String(json?.message || ""), 200),
    });
  }

  return { json, status: res.status, raw, url };
}

export async function loginWithEmailPassword(email: string, password: string) {
  const { json, status } = await postAuthJson("/api/auth/login", { email, password });
  if (loginResponseSucceeded(status, json)) {
    return { token: String(json.token).trim(), json };
  }
  throw new Error(mapAuthErrorToMessage(json, status));
}

export type RegisterAccountType = "customer" | "barber" | "shop_owner";

export type SignupAcceptanceItem = {
  docKey: string;
  docVersion: string;
  accepted: boolean;
};

export type RegisterExtras = {
  acceptances?: SignupAcceptanceItem[];
  appVersion?: string;
  platform?: string;
  language?: string;
  providerType?: string;
  phone?: string;
  shopName?: string;
  businessName?: string;
  address?: string;
  location?: string;
  city?: string;
  state?: string;
};

export async function registerWithEmailPassword(
  name: string,
  email: string,
  password: string,
  accountType: RegisterAccountType = "customer",
  extras: RegisterExtras = {},
) {
  const body: Record<string, unknown> = { name, email, password, accountType };
  if (Array.isArray(extras.acceptances) && extras.acceptances.length > 0) {
    body.acceptances = extras.acceptances;
  }
  if (extras.appVersion) body.appVersion = extras.appVersion;
  if (extras.platform) body.platform = extras.platform;
  if (extras.language) body.language = extras.language;
  if (extras.providerType) body.providerType = extras.providerType;
  if (extras.phone) body.phone = extras.phone;
  if (extras.shopName) body.shopName = extras.shopName;
  if (extras.businessName) body.businessName = extras.businessName;
  if (extras.address) body.address = extras.address;
  if (extras.location) body.location = extras.location;
  if (extras.city) body.city = extras.city;
  if (extras.state) body.state = extras.state;
  const { json, status } = await postAuthJson("/api/auth/register", body);
  if (loginResponseSucceeded(status, json)) {
    return { token: String(json.token).trim(), json };
  }
  throw new Error(mapAuthErrorToMessage(json, status));
}

/**
 * Validates stored JWT against `GET /api/auth/me` (short timeout).
 * Use on cold start so revoked users or bad tokens clear immediately.
 */
export async function getAuthMe(
  token: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; json: JsonAuth; url: string }> {
  const url = apiFullUrl("/api/auth/me");
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    console.error("[auth] FAIL", {
      method: "GET",
      url,
      status: name === "AbortError" ? "TIMEOUT" : "NETWORK",
      responseCode: 0,
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, status: 0, json: {}, url };
  }

  const raw = await res.text();
  let json: JsonAuth = {};
  try {
    json = raw ? (JSON.parse(raw) as JsonAuth) : {};
  } catch {
    console.error("[auth] FAIL", {
      method: "GET",
      url,
      status: "NON_JSON",
      responseCode: res.status,
      body: clip(raw, 400),
    });
    return { ok: false, status: res.status, json: {}, url };
  }

  const ok =
    res.status >= 200 &&
    res.status < 300 &&
    json.ok !== false &&
    json.success !== false &&
    Boolean(json.user);

  if (!ok) {
    console.warn("[auth] FAIL", {
      method: "GET",
      url,
      responseCode: res.status,
      error: json?.error,
      message: clip(String(json?.message || ""), 200),
    });
  }

  return { ok, status: res.status, json, url };
}

const NEUTRAL_RESET_MESSAGE =
  "If an account exists for that email, a password reset link is on the way.";

/** POST /api/auth/forgot-password — Resend email with link to website reset page. */
export async function requestPasswordReset(email: string): Promise<string> {
  const trimmed = String(email || "").trim();
  const { json, status } = await postAuthJson("/api/auth/forgot-password", { email: trimmed });
  if (status >= 200 && status < 300 && json.success !== false) {
    return String(json.message || NEUTRAL_RESET_MESSAGE);
  }
  throw new Error(mapAuthErrorToMessage(json, status));
}

/** DELETE /api/auth/account — permanently removes the signed-in user (App Store 5.1.1(v)). */
export async function deleteMyAccount(token: string): Promise<void> {
  const url = apiFullUrl("/api/auth/account");
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: 28_000,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") throw new Error(UX.errorConnection);
    throw new Error(mapAuthErrorToMessage(null, 0));
  }

  const raw = await res.text();
  let json: JsonAuth = {};
  try {
    json = raw ? (JSON.parse(raw) as JsonAuth) : {};
  } catch {
    throw new Error(UX.errorGeneric);
  }

  if (res.status < 200 || res.status >= 300 || json.ok === false || json.success === false) {
    throw new Error(mapAuthErrorToMessage(json, res.status));
  }
}
