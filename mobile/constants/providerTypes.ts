export const PROVIDER_TYPES = [
  { id: "barber", label: "Barber", role: "barber", bookable: true },
  { id: "beautician", label: "Beautician", role: "barber", bookable: true },
  { id: "nail_tech", label: "Nail Tech", role: "barber", bookable: true },
  { id: "loc_tech", label: "Loc Tech", role: "barber", bookable: true },
  { id: "braider", label: "Braider", role: "barber", bookable: true },
  { id: "stylist", label: "Stylist", role: "barber", bookable: true },
  { id: "shop_owner", label: "Shop Owner", role: "shop_owner", bookable: false },
] as const;

export type ProviderTypeId = (typeof PROVIDER_TYPES)[number]["id"];

export const CUSTOMER_ACCOUNT = { id: "customer", label: "Customer", role: "user" as const };

export function normalizeProviderType(raw: unknown): ProviderTypeId | "customer" | null {
  const id = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (id === "customer" || id === "user" || id === "client") return "customer";
  if (id === "braids") return "braider";
  if (id === "nail_technician" || id === "nail-tech") return "nail_tech";
  if (id === "loc_technician" || id === "loc-tech") return "loc_tech";
  if (PROVIDER_TYPES.some((p) => p.id === id)) return id as ProviderTypeId;
  return null;
}

export function providerTypeMeta(id: string) {
  return PROVIDER_TYPES.find((p) => p.id === id) ?? null;
}
