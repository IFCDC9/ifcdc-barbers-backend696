import { apiFetch } from "./api";
import { apiFullUrl } from "../constants/config";
import { getAuthToken } from "./authService";

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

type ProfilePatchResponse = {
  ok?: boolean;
  success?: boolean;
  user?: AppUser;
  message?: string;
  error?: string;
};

function profileErrorFromResponse(status: number, json: ProfilePatchResponse, raw: string): string {
  const msg = String(json.message || "").trim();
  const err = String(json.error || "").trim();
  if (msg) return msg;
  if (err === "user_not_found") return "Account not found. Sign out and sign in again.";
  if (err === "name_required") return "Name cannot be empty.";
  if (err === "no_fields") return "No profile fields to update.";
  if (err === "unauthorized") return "Session expired. Sign in again.";
  if (err) return err.replace(/_/g, " ");
  if (status === 404) return "Profile update is unavailable on the server. Try again after the app updates.";
  if (status >= 500) return "Server error while saving profile. Try again shortly.";
  return raw.slice(0, 200) || "Profile update failed";
}

/** Upload customer profile photo → persistent HTTPS URL (POST /api/upload). */
export async function uploadProfileAvatar(localUri: string, displayName: string): Promise<string> {
  const token = await getAuthToken();
  const form = new FormData();
  const filename = localUri.split("/").pop() || "profile.jpg";
  form.append("file", { uri: localUri, name: filename, type: "image/jpeg" } as unknown as Blob);
  form.append("barberName", String(displayName || "profile").trim() || "profile");

  const url = apiFullUrl("/api/upload");
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let json: { url?: string; image_url?: string; message?: string; error?: string } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    throw new Error(json.message || json.error || `Upload failed (HTTP ${res.status})`);
  }
  const imageUrl = String(json.url || json.image_url || "").trim();
  if (!imageUrl) throw new Error("Upload did not return an image URL");
  return imageUrl;
}

export async function patchProfile(body: {
  name?: string;
  phone?: string;
  profileImageUrl?: string | null;
}): Promise<AppUser> {
  const res = await apiFetch("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json: ProfilePatchResponse = {};
  try {
    json = raw ? (JSON.parse(raw) as ProfilePatchResponse) : {};
  } catch {
    throw new Error("Invalid response from profile update");
  }
  if (!res.ok || json.ok === false || json.success === false) {
    throw new Error(profileErrorFromResponse(res.status, json, raw));
  }
  if (!json.user) {
    throw new Error(profileErrorFromResponse(res.status, json, raw));
  }
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
