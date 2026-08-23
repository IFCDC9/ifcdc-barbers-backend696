import { UX } from "./uxCopy";

const DEFAULT = UX.errorGeneric;

function sanitize(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b127\.0\.0\.1(?::\d+)?/gi, "")
    .replace(/localhost(?::\d+)?/gi, "")
    .replace(/\[api\][^\n]*/gi, "")
    .replace(/\bnpm run dev\b/gi, "")
    .replace(/\bat\s+\S+\.(tsx?|jsx?|js):\d+:\d+/gi, "")
    .replace(/\bnot_found\b/gi, "")
    .replace(/\bundefined\b/gi, "")
    .replace(/\bnull\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeStackTrace(msg: string): boolean {
  return msg.includes(" at ") && /\.(tsx?|jsx?|js|native)/.test(msg);
}

/** Strip internal diagnostics before showing errors in the UI. */
export function userFacingApiError(e: unknown, fallback = DEFAULT): string {
  if (!(e instanceof Error)) return fallback;
  const msg = sanitize(e.message);
  if (!msg || looksLikeStackTrace(msg)) return fallback;

  // Never show raw backend error codes (e.g. rate_limited).
  if (/^(rate_limited|retry_too_soon|verify_check_failed|verify_send_failed|sms_start_failed|invalid_code)$/i.test(msg)) {
    return "Please wait a moment and try again.";
  }
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(msg)) {
    return "Please wait a moment and try again.";
  }

  if (msg.includes("network error") || msg.includes("Network request failed") || msg.includes("AbortError")) {
    return UX.errorConnection;
  }
  if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("access denied")) {
    if (msg.toLowerCase().includes("expired") || msg.toLowerCase().includes("invalid or expired")) {
      return "Session expired. Sign in again.";
    }
    return "Session expired. Sign in again.";
  }

  const detail = msg.split(" — ").slice(1).join(" — ").trim();
  const candidate = sanitize(detail || msg);

  // Prefer API message body for 4xx/5xx (including 500) so admin tools can diagnose.
  if (candidate && candidate.length <= 280) {
    try {
      const parsed = JSON.parse(candidate) as { message?: string; error?: string; detail?: string; code?: string };
      const parts = [parsed.message, parsed.detail, parsed.code ? `[${parsed.code}]` : ""]
        .map((p) => sanitize(String(p || "")))
        .filter(Boolean);
      if (parts.length) return parts.join(" ").slice(0, 280);
      if (typeof parsed.error === "string") {
        const cleaned = sanitize(parsed.error);
        if (cleaned) return cleaned;
      }
    } catch {
      if (!candidate.startsWith("http")) {
        // Drop transport noise like "500 Internal Server Error" prefixes when a body message exists.
        const withoutStatus = candidate
          .replace(/^\d{3}\s+[A-Za-z ]+\s*/i, "")
          .replace(/^\[api\]\s*/i, "")
          .trim();
        if (withoutStatus) return withoutStatus.slice(0, 280);
        return candidate.slice(0, 280);
      }
    }
  }

  if (msg.includes("404")) {
    const detail404 = e.message.split(" — ").slice(1).join(" — ").trim();
    if (detail404) {
      try {
        const parsed = JSON.parse(detail404) as { message?: string; error?: string };
        if (parsed.message) return sanitize(parsed.message);
        if (parsed.error === "user_not_found") return "Account not found. Sign out and sign in again.";
      } catch {
        if (!detail404.startsWith("<") && detail404.length <= 280) return sanitize(detail404);
      }
    }
    return fallback;
  }
  if (candidate && candidate.length <= 280 && !candidate.startsWith("http")) {
    return candidate;
  }
  if (msg.includes("500") || msg.includes("502") || msg.includes("503")) {
    return `${UX.errorConnection} ${UX.errorRetry}`;
  }
  return fallback;
}
