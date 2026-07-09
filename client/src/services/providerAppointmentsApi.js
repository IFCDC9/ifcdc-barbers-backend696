import { getApiOrigin } from "./api.js";
import { getStoredToken } from "../lib/authHeaders.js";

function authHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" };
}

export async function fetchProviderAppointments(barberId, date) {
  const origin = getApiOrigin();
  const q = new URLSearchParams({ barberId: String(barberId) });
  if (date) q.set("date", date);
  const res = await fetch(`${origin}/api/barber/appointments?${q.toString()}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}
