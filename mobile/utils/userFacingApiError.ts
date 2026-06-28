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

  if (msg.includes("network error") || msg.includes("Network request failed") || msg.includes("AbortError")) {
    return UX.errorConnection;
  }
  if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("access denied")) {
    return UX.errorPermission;
  }
  if (msg.includes("500") || msg.includes("502") || msg.includes("503")) {
    return `${UX.errorConnection} ${UX.errorRetry}`;
  }

  const detail = msg.split(" — ").slice(1).join(" — ").trim();
  const candidate = sanitize(detail || msg);
  if (candidate && candidate.length <= 140) {
    try {
      const parsed = JSON.parse(candidate) as { message?: string; error?: string };
      if (parsed.message) {
        const cleaned = sanitize(parsed.message);
        if (cleaned) return cleaned;
      }
      if (typeof parsed.error === "string") {
        const cleaned = sanitize(parsed.error);
        if (cleaned) return cleaned;
      }
    } catch {
      if (!candidate.startsWith("http")) return candidate;
    }
  }

  if (msg.includes("404")) return fallback;
  return fallback;
}
