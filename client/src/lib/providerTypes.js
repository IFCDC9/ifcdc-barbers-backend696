export const PROVIDER_TYPES = [
  { id: "barber", label: "Barber", role: "barber", bookable: true },
  { id: "beautician", label: "Beautician", role: "barber", bookable: true },
  { id: "nail_tech", label: "Nail Tech", role: "barber", bookable: true },
  { id: "loc_tech", label: "Loc Tech", role: "barber", bookable: true },
  { id: "braider", label: "Braider", role: "barber", bookable: true },
  { id: "stylist", label: "Stylist", role: "barber", bookable: true },
  { id: "shop_owner", label: "Shop Owner", role: "shop_owner", bookable: false },
];

export function normalizeProviderType(raw) {
  const id = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (id === "customer" || id === "user") return "customer";
  if (id === "braids") return "braider";
  if (PROVIDER_TYPES.some((p) => p.id === id)) return id;
  return null;
}

export function providerTypeLabel(id) {
  const normalized = normalizeProviderType(id) || String(id || "barber");
  return PROVIDER_TYPES.find((p) => p.id === normalized)?.label || "Barber";
}
