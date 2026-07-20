import { apiFetch } from "./api";

export type AdminStats = {
  totalRevenue?: number;
  totalRevenuePlatform?: number;
  platformFeesCollected?: number;
  paidBookingsCount?: number;
  confirmedBookingsCount?: number;
  allBookingsCount?: number;
  totalBookings?: number;
  pendingPaymentsAmount?: number;
  pendingPaymentsCount?: number;
  outstandingBalanceAmount?: number;
  outstandingBalanceCount?: number;
  avgBooking?: number;
  highestPayment?: number;
  lastPaymentAt?: string | null;
};

export type AdminBarberRow = {
  id: string | number;
  name?: string;
  phone?: string | null;
  user_id?: string | null;
};

export async function fetchAdminStats(): Promise<AdminStats> {
  const res = await apiFetch("/api/admin/stats");
  const json = (await res.json()) as AdminStats & { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || `Admin stats failed (${res.status})`);
  }
  return json;
}

export type HubSpotHqKpis = {
  ok?: boolean;
  enabled?: boolean;
  windowDays?: number;
  message?: string;
  customerGrowth?: { newCustomers?: number; totalCustomers?: number; growthRate?: number };
  returningCustomerRate?: { ratePercent?: number; returningCustomers?: number; customers?: number };
  appointmentVolume?: { totals?: { appointments?: number; paid?: number; completed?: number } };
  revenueTrends?: { totals?: { revenue?: number; platformFees?: number } };
  topBarbers?: Array<{ barberId?: string | number; name?: string; revenue?: number; paidAppointments?: number }>;
  topShops?: Array<{ businessId?: string | number; name?: string; revenue?: number; paidAppointments?: number }>;
  hubspotSyncHealth?: {
    contacts?: { synced?: number };
    companies?: { synced?: number };
    deals?: { synced?: number };
  };
};

export async function fetchHubSpotHqKpis(days = 30): Promise<HubSpotHqKpis> {
  const res = await apiFetch(`/api/admin/hubspot/kpis?days=${encodeURIComponent(days)}`);
  const json = (await res.json()) as HubSpotHqKpis & { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || `HubSpot KPIs failed (${res.status})`);
  }
  return json;
}

export async function fetchAdminBarbers(): Promise<AdminBarberRow[]> {
  const res = await apiFetch("/api/barber/list");
  const json = (await res.json()) as { barbers?: AdminBarberRow[]; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || `Barber list failed (${res.status})`);
  }
  return Array.isArray(json.barbers) ? json.barbers : [];
}
