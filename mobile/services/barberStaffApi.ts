import { apiFetch } from "./api";
import { apiFullUrl } from "../constants/config";
import { getAuthToken } from "./authService";

function withBarberId(path: string, barberId: string | number, extra?: Record<string, string>): string {
  const id = encodeURIComponent(String(barberId));
  const q = new URLSearchParams({ barberId: id });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && String(v).trim()) q.set(k, String(v));
    }
  }
  const qs = q.toString();
  return `${path}?${qs}`;
}

export type BarberProfile = {
  id: string | number;
  user_id?: string | null;
  name?: string;
  bio?: string | null;
  profile_image?: string | null;
  logo?: string | null;
  location?: string | null;
  phone?: string | null;
  shop_name?: string | null;
  portfolio_headline?: string | null;
  years_experience?: number | null;
  public_slug?: string | null;
  business_name?: string | null;
  business_phone?: string | null;
  business_address?: string | null;
  business_city?: string | null;
  business_state?: string | null;
  created_at?: string | null;
};

export type BarberServiceRow = {
  id: string | number;
  barber_id?: string | number;
  business_id?: string | number | null;
  barber_name?: string | null;
  shop_name?: string | null;
  name?: string;
  description?: string | null;
  category?: string | null;
  icon?: string | null;
  image_url?: string | null;
  price?: number;
  duration_minutes?: number;
  is_active?: boolean;
  created_at?: string | null;
};

export type BarberServiceInput = {
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  image_url?: string;
  price: number;
  duration_minutes: number;
  is_active?: boolean;
};

export type BarberBillingSummary = {
  totalBookings?: number;
  serviceTotalUsd?: number;
  subscription_tier?: string;
  aura_available?: boolean;
};

export async function fetchBarberProfile(barberId: string | number): Promise<BarberProfile | null> {
  const res = await apiFetch(withBarberId("/api/barber/profile", barberId));
  const json = (await res.json()) as { profile?: BarberProfile; message?: string; error?: string };
  if (!res.ok) return null;
  return json.profile ?? null;
}

export async function saveBarberProfile(
  barberId: string | number,
  body: {
    name?: string;
    phone?: string;
    bio?: string;
    location?: string;
    shop_name?: string;
    portfolio_headline?: string;
    years_experience?: number | null;
    business_address?: string;
    business_city?: string;
    business_state?: string;
    profile_image?: string;
    logo?: string;
  },
): Promise<BarberProfile | null> {
  const res = await apiFetch(withBarberId("/api/barber/profile", barberId), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { profile?: BarberProfile; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || "Profile save failed");
  }
  return json.profile ?? null;
}

export async function fetchBarberServices(
  barberId: string | number,
  opts?: { includeInactive?: boolean },
): Promise<BarberServiceRow[]> {
  const extra = opts?.includeInactive ? { includeInactive: "true" } : undefined;
  const res = await apiFetch(withBarberId("/api/barber/services", barberId, extra));
  const json = (await res.json()) as { services?: BarberServiceRow[]; message?: string; error?: string };
  if (!res.ok) return [];
  return Array.isArray(json.services) ? json.services : [];
}

export async function createBarberService(
  barberId: string | number,
  body: BarberServiceInput,
): Promise<BarberServiceRow> {
  const res = await apiFetch(withBarberId("/api/barber/services", barberId), {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { service?: BarberServiceRow; message?: string; error?: string };
  if (!res.ok || !json.service) {
    throw new Error(json.message || json.error || "Could not create service");
  }
  return json.service;
}

export async function updateBarberService(
  barberId: string | number,
  serviceId: string | number,
  body: Partial<BarberServiceInput>,
): Promise<BarberServiceRow> {
  const res = await apiFetch(withBarberId(`/api/barber/services/${serviceId}`, barberId), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { service?: BarberServiceRow; message?: string; error?: string };
  if (!res.ok || !json.service) {
    throw new Error(json.message || json.error || "Could not update service");
  }
  return json.service;
}

export async function deleteBarberService(
  barberId: string | number,
  serviceId: string | number,
): Promise<void> {
  const res = await apiFetch(withBarberId(`/api/barber/services/${serviceId}`, barberId), {
    method: "DELETE",
  });
  if (!res.ok) {
    const json = (await res.json()) as { message?: string; error?: string };
    throw new Error(json.message || json.error || "Could not delete service");
  }
}

export async function archiveBarberService(
  barberId: string | number,
  serviceId: string | number,
): Promise<BarberServiceRow> {
  return updateBarberService(barberId, serviceId, { is_active: false });
}

export async function uploadBarberServiceImage(
  barberId: string | number,
  localUri: string,
): Promise<string> {
  const token = await getAuthToken();
  const form = new FormData();
  const filename = localUri.split("/").pop() || "service.jpg";
  form.append("file", { uri: localUri, name: filename, type: "image/jpeg" } as unknown as Blob);
  const url = apiFullUrl(withBarberId("/api/upload", barberId));
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const json = (await res.json()) as { url?: string; image_url?: string; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(json.message || json.error || "Image upload failed");
  }
  const rel = String(json.image_url || json.url || "").trim();
  if (!rel) throw new Error("Server did not return an image URL.");
  return rel.startsWith("http") ? rel : apiFullUrl(rel);
}

export async function fetchBarberBillingSummary(
  barberId: string | number,
): Promise<BarberBillingSummary | null> {
  const id = encodeURIComponent(String(barberId));
  const res = await apiFetch(`/api/barber/billing-summary/${id}`);
  const json = (await res.json()) as BarberBillingSummary & { message?: string; error?: string };
  if (!res.ok) return null;
  return json;
}
