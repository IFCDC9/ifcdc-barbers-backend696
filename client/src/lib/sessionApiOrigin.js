/** Split-host production API (ifcdcbarbersapp.com static → backend696). Never use this from d8ui. */
export const PRODUCTION_API_ORIGIN = "https://ifcdc-barbers-backend696.onrender.com";
export const D8UI_API_ORIGIN = "https://ifcdc-barbers-backend696-d8ui.onrender.com";
export const D8UI_HOSTNAME = "ifcdc-barbers-backend696-d8ui.onrender.com";

export function isD8uiHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/:\d+$/, "")
    .trim();
  return host === D8UI_HOSTNAME || host.includes("backend696-d8ui");
}

export function isD8uiOrigin(origin) {
  try {
    const u = new URL(String(origin || "").trim());
    return isD8uiHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Origin for wake/refresh/API when the Vite-configured base may be empty.
 * d8ui pages always stay on d8ui (relative `/api` or the d8ui origin) — never production backend696.
 */
export function resolveSessionApiOrigin({ configuredBase, hostname } = {}) {
  const configured = String(configuredBase ?? "").trim().replace(/\/$/, "");
  if (isD8uiHost(hostname)) {
    if (configured && isD8uiOrigin(configured)) return configured;
    return "";
  }
  if (configured) return configured;
  return PRODUCTION_API_ORIGIN;
}

export function sessionApiUrl(path, origin) {
  const p = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  const o = String(origin ?? "").replace(/\/$/, "");
  return o ? `${o}${p}` : p;
}
