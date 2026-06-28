import { apiFetch } from "./api";

export type AppUser = {
  id?: string;
  name?: string;
  email?: string;
  phone?: string | null;
  profileImageUrl?: string | null;
  role?: string;
  isOwner?: boolean;
  isSuperAdmin?: boolean;
  businessId?: number | null;
  barberId?: number | null;
};

export type BookingRow = {
  id: string;
  customer_name?: string;
  customer_email?: string;
  barber_name?: string;
  barber_id?: string | number;
  service?: string;
  date?: string;
  time?: string;
  payment_status?: string;
  booking_status?: string;
  total_amount?: number | string;
  amount_paid?: number | string;
  balance_due?: number | string;
  remaining_balance?: number | string;
  platform_fee?: number | string;
  created_at?: string;
};

export async function patchProfile(body: {
  name?: string;
  phone?: string;
  profileImageUrl?: string | null;
}): Promise<AppUser> {
  const res = await apiFetch("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { user?: AppUser };
  if (!json.user) throw new Error("Profile update did not return user");
  return json.user;
}

export async function fetchMyBookings(): Promise<BookingRow[]> {
  const res = await apiFetch("/api/auth/my-bookings");
  const json = (await res.json()) as { bookings?: BookingRow[] };
  return Array.isArray(json.bookings) ? json.bookings : [];
}

export async function fetchAdminBookings(): Promise<BookingRow[]> {
  const res = await apiFetch("/api/admin/bookings");
  const json = (await res.json()) as { bookings?: BookingRow[] };
  return Array.isArray(json.bookings) ? json.bookings : [];
}
