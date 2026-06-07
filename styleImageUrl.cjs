/**
 * Published style/service image URLs — reject ephemeral Render disk paths and blobs.
 */
const FALLBACK_STYLE_IMAGE_URL = "https://ifcdcbarbersapp.com/icon-512.png";

function isEphemeralUploadUrl(url) {
  const u = String(url || "").trim();
  if (!u) return true;
  if (u.startsWith("blob:")) return true;
  if (u.includes("supabase.co/storage/")) return false;
  if (u.includes("/uploads/")) return true;
  return false;
}

function isRenderableImageUrl(url) {
  const u = String(url || "").trim();
  if (!u || u.startsWith("blob:")) return false;
  if (isEphemeralUploadUrl(u)) return false;
  return u.startsWith("https://") || u.startsWith("http://");
}

/**
 * Normalize image_url for public API responses (never return dead /uploads paths).
 * @returns {string} HTTPS URL suitable for <img src>
 */
function normalizePublishedImageUrl(raw, ctx = {}) {
  const original = String(raw || "").trim();
  if (!original) {
    if (ctx.styleId || ctx.serviceId) {
      console.warn("[style-image] empty image_url", {
        styleId: ctx.styleId,
        barberId: ctx.barberId,
        serviceId: ctx.serviceId,
      });
    }
    return FALLBACK_STYLE_IMAGE_URL;
  }
  if (isEphemeralUploadUrl(original)) {
    console.warn("[style-image] ephemeral/broken image_url replaced", {
      styleId: ctx.styleId,
      barberId: ctx.barberId,
      serviceId: ctx.serviceId,
      image_url: original,
      fallback: FALLBACK_STYLE_IMAGE_URL,
    });
    return FALLBACK_STYLE_IMAGE_URL;
  }
  if (original.startsWith("https://") || original.startsWith("http://")) {
    return original;
  }
  console.warn("[style-image] relative/non-http image_url replaced", {
    styleId: ctx.styleId,
    barberId: ctx.barberId,
    serviceId: ctx.serviceId,
    image_url: original,
  });
  return FALLBACK_STYLE_IMAGE_URL;
}

module.exports = {
  FALLBACK_STYLE_IMAGE_URL,
  isEphemeralUploadUrl,
  isRenderableImageUrl,
  normalizePublishedImageUrl,
};
