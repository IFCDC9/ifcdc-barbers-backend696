import { apiFetch } from "./api";

export type AdminBarberRow = {
  id: string;
  barberId: string;
  userId: string | null;
  fullName: string;
  shopName: string;
  city: string | null;
  state: string | null;
  locationLabel: string;
  email: string;
  phone: string | null;
  registrationDate: string | null;
  accountStatus: string;
  subscriptionStatus: string;
  verificationStatus: string;
  isActive: boolean;
  pendingApproval: boolean;
  businessId: number | null;
};

export type AdminBarberFilters = {
  shop?: string;
  city?: string;
  state?: string;
  active?: "active" | "inactive" | "";
  pendingApproval?: boolean;
  sort?: "newest" | "oldest" | "name" | "shop";
};

function queryString(filters: AdminBarberFilters): string {
  const q = new URLSearchParams();
  if (filters.shop) q.set("shop", filters.shop);
  if (filters.city) q.set("city", filters.city);
  if (filters.state) q.set("state", filters.state);
  if (filters.active) q.set("active", filters.active);
  if (filters.pendingApproval) q.set("pendingApproval", "true");
  if (filters.sort === "oldest") q.set("sort", "asc");
  else if (filters.sort === "name") q.set("sort", "name");
  else if (filters.sort === "shop") q.set("sort", "shop");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchAdminBarbers(filters: AdminBarberFilters = {}): Promise<AdminBarberRow[]> {
  const res = await apiFetch(`/api/admin/barbers${queryString(filters)}`);
  const json = (await res.json()) as { ok?: boolean; barbers?: AdminBarberRow[]; message?: string };
  if (!res.ok || json.ok === false) {
    throw new Error(json.message || `Failed to load barbers (${res.status})`);
  }
  return Array.isArray(json.barbers) ? json.barbers : [];
}

export async function patchBarberVerification(barberId: string | number, status: "pending" | "approved" | "rejected") {
  const res = await apiFetch(`/api/admin/barbers/${encodeURIComponent(String(barberId))}/verification`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Update failed (${res.status})`);
  return json;
}

export async function patchBarberAccountStatus(
  barberId: string | number,
  status: "approved" | "pending" | "suspended",
) {
  const res = await apiFetch(`/api/admin/barbers/${encodeURIComponent(String(barberId))}/account-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Update failed (${res.status})`);
  return json;
}

export type AdminNotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  payload?: { barberId?: number } | null;
  readAt: string | null;
  createdAt: string | null;
};

export async function fetchAdminNotifications(unreadOnly = false): Promise<AdminNotificationRow[]> {
  const q = unreadOnly ? "?unreadOnly=true" : "";
  const res = await apiFetch(`/api/admin/notifications${q}`);
  const json = (await res.json()) as { ok?: boolean; notifications?: AdminNotificationRow[]; message?: string };
  if (!res.ok || json.ok === false) throw new Error(json.message || `Failed to load notifications (${res.status})`);
  return Array.isArray(json.notifications) ? json.notifications : [];
}
