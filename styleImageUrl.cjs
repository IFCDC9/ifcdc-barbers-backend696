/**
 * Published style/service image URLs — reject ephemeral Render disk paths and blobs.
 */
const FALLBACK_STYLE_IMAGE_URL = "https://ifcdcbarbersapp.com/icon-512.png";

function isUnsupportedBrowserImageUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  return /\.heic(?:\?|$)/.test(u) || /\.heif(?:\?|$)/.test(u);
}

function isPlaceholderImageUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  return u.includes("icon-512.png");
}

function isEphemeralUploadUrl(url) {
  const u = String(url || "").trim();
  if (!u) return true;
  if (u.startsWith("blob:")) return true;
  if (isPlaceholderImageUrl(u)) return true;
  if (u.includes("supabase.co/storage/")) return false;
  if (isUnsupportedBrowserImageUrl(u)) return true;
  if (u.includes("/uploads/")) return true;
  return false;
}

/** Reject URLs that must never be persisted as uploaded photos. */
function assertPersistableImageUrl(url, label = "image_url") {
  const u = String(url || "").trim();
  if (!u) throw new Error(`${label}_required`);
  if (isPlaceholderImageUrl(u)) throw new Error(`${label}_placeholder_not_allowed`);
  if (isEphemeralUploadUrl(u)) throw new Error(`${label}_not_persistable`);
  return u;
}

function isRenderableImageUrl(url) {
  const u = String(url || "").trim();
  if (!u || u.startsWith("blob:")) return false;
  if (isEphemeralUploadUrl(u)) return false;
  if (isPlaceholderImageUrl(u)) return false;
  return u.startsWith("https://") || u.startsWith("http://");
}

/**
 * Valid published photo URL, or "" when missing / placeholder / broken.
 * Booking APIs use this so clients only show the IFCDC placeholder when truly empty.
 */
function resolvePublishedImageUrl(raw, ctx = {}) {
  const original = String(raw || "").trim();
  if (!original) return "";
  if (isPlaceholderImageUrl(original) || isEphemeralUploadUrl(original)) {
    if (ctx.serviceId || ctx.styleId) {
      console.warn("[style-image] ignoring non-persistable image_url", {
        styleId: ctx.styleId,
        barberId: ctx.barberId,
        serviceId: ctx.serviceId,
        image_url: original,
      });
    }
    return "";
  }
  if (original.startsWith("https://") || original.startsWith("http://")) {
    return original;
  }
  return "";
}

/**
 * Normalize image_url for public API responses (never return dead /uploads paths).
 * @returns {string} HTTPS URL suitable for <img src>
 */
function normalizePublishedImageUrl(raw, ctx = {}) {
  return resolvePublishedImageUrl(raw, ctx) || FALLBACK_STYLE_IMAGE_URL;
}

module.exports = {
  FALLBACK_STYLE_IMAGE_URL,
  isPlaceholderImageUrl,
  isEphemeralUploadUrl,
  isRenderableImageUrl,
  resolvePublishedImageUrl,
  normalizePublishedImageUrl,
  assertPersistableImageUrl,
};
