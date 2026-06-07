import { apiFullUrl } from "../constants/config";

export const FALLBACK_STYLE_IMAGE_URL = "https://ifcdcbarbersapp.com/icon-512.png";

export function isEphemeralStyleImageUrl(url: string | null | undefined): boolean {
  const u = String(url || "").trim();
  if (!u) return true;
  if (u.startsWith("blob:")) return true;
  if (u.includes("supabase.co/storage/")) return false;
  if (u.includes("/uploads/")) return true;
  return false;
}

export function isRenderableStyleImageUrl(url: string | null | undefined): boolean {
  const u = String(url || "").trim();
  if (!u || u.startsWith("blob:")) return false;
  if (isEphemeralStyleImageUrl(u)) return false;
  return u.startsWith("https://") || u.startsWith("http://") || u.startsWith("/");
}

export function resolveStyleImageUrl(raw: string | null | undefined): string {
  const original = String(raw || "").trim();
  if (!original || isEphemeralStyleImageUrl(original)) {
    return FALLBACK_STYLE_IMAGE_URL;
  }
  if (original.startsWith("http://") || original.startsWith("https://")) {
    return original;
  }
  if (original.startsWith("/")) {
    const full = apiFullUrl(original);
    return isEphemeralStyleImageUrl(full) ? FALLBACK_STYLE_IMAGE_URL : full;
  }
  return FALLBACK_STYLE_IMAGE_URL;
}
