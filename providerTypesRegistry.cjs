/**
 * Service provider categories for the IFCDC beauty marketplace.
 * Auth role stays `barber` for all bookable providers; shop_owner is separate.
 */
const PROVIDER_TYPES = [
  { id: "barber", label: "Barber", role: "barber", bookable: true },
  { id: "beautician", label: "Beautician", role: "barber", bookable: true },
  { id: "nail_tech", label: "Nail Tech", role: "barber", bookable: true },
  { id: "loc_tech", label: "Loc Tech", role: "barber", bookable: true },
  { id: "braider", label: "Braider", role: "barber", bookable: true },
  { id: "stylist", label: "Stylist", role: "barber", bookable: true },
  { id: "shop_owner", label: "Shop Owner", role: "shop_owner", bookable: false },
];

const PROVIDER_TYPE_IDS = PROVIDER_TYPES.map((p) => p.id);
const PROVIDER_TYPE_SET = new Set(PROVIDER_TYPE_IDS);

const BOOKABLE_PROVIDER_TYPE_IDS = PROVIDER_TYPES.filter((p) => p.bookable).map((p) => p.id);

function normalizeProviderType(raw) {
  const id = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (id === "braids") return "braider";
  if (id === "nail_technician" || id === "nail-tech") return "nail_tech";
  if (id === "loc_technician" || id === "loc-tech") return "loc_tech";
  if (PROVIDER_TYPE_SET.has(id)) return id;
  return null;
}

function providerTypeMeta(id) {
  const norm = normalizeProviderType(id);
  return PROVIDER_TYPES.find((p) => p.id === norm) || null;
}

function resolveRegistrationProviderType(body = {}) {
  const raw =
    body.providerType ??
    body.provider_type ??
    body.serviceProviderType ??
    body.service_provider_type;
  const fromExplicit = normalizeProviderType(raw);
  if (fromExplicit) return fromExplicit;

  const account = String(body.accountType ?? body.account_type ?? "")
    .trim()
    .toLowerCase();
  if (!account || account === "customer" || account === "user" || account === "client") return null;
  if (account === "shop_owner") return "shop_owner";
  if (account === "barber") return "barber";
  return normalizeProviderType(body.role);
}

function authRoleForProviderType(providerType) {
  const meta = providerTypeMeta(providerType);
  return meta?.role || "user";
}

module.exports = {
  PROVIDER_TYPES,
  PROVIDER_TYPE_IDS,
  BOOKABLE_PROVIDER_TYPE_IDS,
  normalizeProviderType,
  providerTypeMeta,
  resolveRegistrationProviderType,
  authRoleForProviderType,
};
