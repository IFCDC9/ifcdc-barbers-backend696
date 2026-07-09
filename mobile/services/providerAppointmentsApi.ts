import { apiFetch } from "./api";

export type ProviderAppointment = {
  id: string;
  customerName: string;
  customerEmail: string;
  service: string;
  styleImageUrl: string | null;
  clientPhotoUrl: string | null;
  date: string;
  time: string;
  paymentStatus: string;
  bookingStatus: string;
  totalAmount: number;
  durationMinutes: number;
  phone: string;
};

export async function fetchProviderAppointments(
  barberId: string | number,
  date?: string,
): Promise<{ date: string; timezone: string; appointments: ProviderAppointment[] }> {
  const q = new URLSearchParams({ barberId: String(barberId) });
  if (date) q.set("date", date);
  const res = await apiFetch(`/api/barber/appointments?${q.toString()}`);
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || "Could not load appointments");
  }
  return {
    date: String(data.date || date || ""),
    timezone: String(data.timezone || "America/New_York"),
    appointments: Array.isArray(data.appointments) ? data.appointments : [],
  };
}
