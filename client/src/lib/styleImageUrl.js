import { PRODUCTION_API_ORIGIN } from "../config/api.js";

export const FALLBACK_STYLE_IMAGE_URL = "https://ifcdcbarbersapp.com/icon-512.png";

/** Ephemeral disk uploads (Render /uploads) or blob URLs — not safe for production display. */
export function isEphemeralStyleImageUrl(url) {
  const u = String(url || "").trim();
  if (!u) return true;
  if (u.startsWith("blob:")) return true;
  if (u.includes("supabase.co/storage/")) return false;
  if (u.includes("/uploads/")) return true;
  return false;
}

export function isRenderableStyleImageUrl(url) {
  const u = String(url || "").trim();
  if (!u || u.startsWith("blob:")) return false;
  if (isEphemeralStyleImageUrl(u)) return false;
  return u.startsWith("https://") || u.startsWith("http://") || u.startsWith("/");
}

/**
 * Resolve style/service image for <img src>. Never returns dead /uploads URLs.
 */
export function resolveStyleImageUrl(raw, apiOrigin) {
  const original = String(raw || "").trim();
  if (!original || isEphemeralStyleImageUrl(original)) {
    return FALLBACK_STYLE_IMAGE_URL;
  }
  if (original.startsWith("https://") || original.startsWith("http://")) {
    return original;
  }
  if (original.startsWith("/")) {
    const base =
      apiOrigin ||
      (typeof window !== "undefined" && window.location?.hostname?.includes("ifcdcbarbersapp.com")
        ? PRODUCTION_API_ORIGIN
        : typeof window !== "undefined"
          ? window.location.origin
          : "");
    if (!base || isEphemeralStyleImageUrl(`${base}${original}`)) {
      return FALLBACK_STYLE_IMAGE_URL;
    }
    return `${String(base).replace(/\/$/, "")}${original}`;
  }
  return FALLBACK_STYLE_IMAGE_URL;
}
