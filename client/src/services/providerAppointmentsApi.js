import { authenticatedFetch } from "../lib/authenticatedFetch.js";

export async function fetchProviderAppointments(barberId, date) {
  const q = new URLSearchParams({ barberId: String(barberId) });
  if (date) q.set("date", date);
  const res = await authenticatedFetch(`/api/barber/appointments?${q.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}
