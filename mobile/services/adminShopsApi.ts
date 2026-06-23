import { apiFetch } from "./api";

export type AdminShopRow = {
  id: string;
  businessId: number;
  shopName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string | null;
  city: string | null;
  state: string | null;
  locationLabel: string;
  address: string;
  accountStatus: string;
  approvalStatus: string;
  accessPlan: string;
  subscriptionStatus: string;
  bookingsEnabled: boolean;
  paymentProcessingEnabled: boolean;
  platformFeesEnabled?: boolean;
  subscriptionEnabled?: boolean;
  websiteAccessEnabled?: boolean;
  mobileAppAccessEnabled?: boolean;
  freeAccessEnabled: boolean;
  paidSubscriptionRequired: boolean;
  barberCount: number;
  bookingCount: number;
  customerCount: number;
  totalRevenue: number;
  platformFees: number;
  pendingApproval: boolean;
  trialEndsAt: string | null;
  monthlyPrice: number;
};

export type AdminShopDashboard = {
  totalShops: number;
  activeShops: number;
  pendingShops: number;
  suspendedShops: number;
  paidShops: number;
  freeShops: number;
  trialShops: number;
  monthlyRecurringRevenue: number;
  platformFeeRevenue: number;
};

export type AdminShopDetail = {
  shop: AdminShopRow;
  barbers: Array<{ id: string; name: string; email: string | null; verificationStatus: string }>;
  services: Array<{ id: string; name: string; price: number; barberName: string }>;
  bookings: Array<{ id: string; name: string; service: string; totalPrice: number; paymentStatus: string }>;
  customers: Array<{ name: string; email: string; phone: string | null }>;
};

export type AdminShopFilters = {
  shop?: string;
  city?: string;
  state?: string;
  status?: string;
  pendingApproval?: boolean;
};

function queryString(filters: AdminShopFilters): string {
  const q = new URLSearchParams();
  if (filters.shop) q.set("shop", filters.shop);
  if (filters.city) q.set("city", filters.city);
  if (filters.state) q.set("state", filters.state);
  if (filters.status) q.set("status", filters.status);
  if (filters.pendingApproval) q.set("pendingApproval", "true");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchAdminShopDashboard(): Promise<{
  dashboard: AdminShopDashboard;
  pendingQueue: AdminShopRow[];
}> {
  const res = await apiFetch("/api/admin/shops/dashboard");
  const json = (await res.json()) as {
    ok?: boolean;
    dashboard?: AdminShopDashboard;
    pendingQueue?: AdminShopRow[];
    message?: string;
  };
  if (!res.ok || json.ok === false) throw new Error(json.message || `Failed to load dashboard (${res.status})`);
  return {
    dashboard: json.dashboard || {
      totalShops: 0,
      activeShops: 0,
      pendingShops: 0,
      suspendedShops: 0,
      paidShops: 0,
      freeShops: 0,
      trialShops: 0,
      monthlyRecurringRevenue: 0,
      platformFeeRevenue: 0,
    },
    pendingQueue: Array.isArray(json.pendingQueue) ? json.pendingQueue : [],
  };
}

export async function fetchAdminShops(filters: AdminShopFilters = {}): Promise<AdminShopRow[]> {
  const res = await apiFetch(`/api/admin/shops${queryString(filters)}`);
  const json = (await res.json()) as { ok?: boolean; shops?: AdminShopRow[]; message?: string };
  if (!res.ok || json.ok === false) throw new Error(json.message || `Failed to load shops (${res.status})`);
  return Array.isArray(json.shops) ? json.shops : [];
}

export async function fetchAdminShopDetail(shopId: string | number): Promise<AdminShopDetail> {
  const res = await apiFetch(`/api/admin/shops/${encodeURIComponent(String(shopId))}`);
  const json = (await res.json()) as AdminShopDetail & { ok?: boolean; message?: string };
  if (!res.ok || json.ok === false) throw new Error(json.message || `Failed to load shop (${res.status})`);
  return json;
}

export async function approveAdminShop(shopId: string | number, plan: string) {
  const res = await apiFetch(`/api/admin/shops/${encodeURIComponent(String(shopId))}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Approve failed (${res.status})`);
  return json;
}

export async function rejectAdminShop(shopId: string | number, reason = "") {
  const res = await apiFetch(`/api/admin/shops/${encodeURIComponent(String(shopId))}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Reject failed (${res.status})`);
  return json;
}

export async function patchAdminShopAccess(shopId: string | number, body: Record<string, unknown>) {
  const res = await apiFetch(`/api/admin/shops/${encodeURIComponent(String(shopId))}/access`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Update failed (${res.status})`);
  return json;
}

export async function patchAdminShopAccountStatus(shopId: string | number, status: "active" | "suspended" | "pending") {
  const res = await apiFetch(`/api/admin/shops/${encodeURIComponent(String(shopId))}/account-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Status update failed (${res.status})`);
  return json;
}
