/**
 * Shared public web URLs (backend invite emails, SMS, docs).
 */
const CANONICAL_PUBLIC_ORIGIN = "https://ifcdcbarbersapp.com";
const RENDER_FRONTEND_ORIGIN = "https://ifcdc-barbers-frontend.onrender.com";

function stripTrailingSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function looksLikeApiOrigin(url) {
  const u = String(url).toLowerCase();
  return u.includes("backend696") || u.includes("backend.onrender.com") || u.includes("/api");
}

/**
 * SPA origin for invite links, booking emails, and public marketing URLs.
 * Production: FRONTEND_URL=https://ifcdcbarbersapp.com (Render backend696 env).
 * PUBLIC_WEB_FALLBACK_URL is emergency fallback only (Render SPA).
 */
function resolvePublicWebOrigin() {
  const configured = stripTrailingSlash(
    process.env.FRONTEND_URL ||
      process.env.PUBLIC_WEB_URL ||
      process.env.PUBLIC_CLIENT_URL ||
      process.env.VITE_APP_URL ||
      process.env.APP_URL ||
      process.env.PUBLIC_URL ||
      "",
  );
  if (configured && !looksLikeApiOrigin(configured)) {
    return configured;
  }
  const fallback = stripTrailingSlash(
    process.env.PUBLIC_WEB_FALLBACK_URL || RENDER_FRONTEND_ORIGIN,
  );
  return CANONICAL_PUBLIC_ORIGIN || fallback;
}

function buildInviteAcceptUrl(inviteToken) {
  const base = resolvePublicWebOrigin();
  return `${base}/invite?token=${encodeURIComponent(String(inviteToken || "").trim())}`;
}

function buildPasswordResetUrl(rawToken) {
  const base = resolvePublicWebOrigin();
  return `${base}/reset-password?token=${encodeURIComponent(String(rawToken || "").trim())}`;
}

module.exports = {
  CANONICAL_PUBLIC_ORIGIN,
  RENDER_FRONTEND_ORIGIN,
  resolvePublicWebOrigin,
  buildInviteAcceptUrl,
  buildPasswordResetUrl,
};
