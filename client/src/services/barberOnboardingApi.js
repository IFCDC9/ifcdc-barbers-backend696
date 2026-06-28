import { getApiOrigin } from "./api.js";
import { apiFetch } from "../lib/ngrokFetch.js";

function authHeaders() {
  try {
    const t = localStorage.getItem("token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

/**
 * POST /api/barber/onboard — register barber (public).
 * @param {object} body
 */
export async function postBarberOnboardRegister(body) {
  const origin = getApiOrigin();
  const res = await apiFetch(`${origin}/api/barber/onboard`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const raw = String(data?.message || data?.error || "");
    const duplicate =
      res.status === 409 ||
      String(data?.error || "").toLowerCase() === "email_exists" ||
      /already\s*registered|email\s*is\s*already/i.test(raw);
    const msg = duplicate ? "Sign in to continue setup." : raw || `Onboard failed (${res.status})`;
    const err = new Error(msg);
    err.httpStatus = res.status;
    err.payload = data;
    err.duplicateEmail = duplicate;
    throw err;
  }
  return data;
}

/** PUT /api/barber/profile — authenticated barber. */
export async function putBarberProfile(patch) {
  const origin = getApiOrigin();
  const res = await apiFetch(`${origin}/api/barber/profile`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(patch || {}),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new Error(data?.message || data?.error || `Profile save failed (${res.status})`);
  return data;
}

/** POST /api/barber/onboard/services — replace all services for barber. */
export async function postOnboardServices(services) {
  const origin = getApiOrigin();
  const res = await apiFetch(`${origin}/api/barber/onboard/services`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ services }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new Error(data?.message || data?.error || `Services save failed (${res.status})`);
  return data;
}

/** POST /api/barber/onboard/complete — create default style for booking. */
export async function postOnboardComplete() {
  const origin = getApiOrigin();
  const res = await apiFetch(`${origin}/api/barber/onboard/complete`, {
    method: "POST",
    headers: { ...authHeaders(), Accept: "application/json" },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new Error(data?.message || data?.error || `Launch failed (${res.status})`);
  return data;
}

/**
 * POST /api/barber/onboard/branding — multipart `file` + form field `slot` = logo | profile
 * @param {"logo"|"profile"} slot
 * @param {File} file
 */
export async function postBarberMedia(slot, file) {
  const origin = getApiOrigin();
  const fd = new FormData();
  fd.append("file", file);
  fd.append("slot", slot === "logo" ? "logo" : "profile");
  const res = await apiFetch(`${origin}/api/barber/onboard/branding`, {
    method: "POST",
    headers: { ...authHeaders(), Accept: "application/json" },
    body: fd,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new Error(data?.message || data?.error || `Upload failed (${res.status})`);
  return data;
}
