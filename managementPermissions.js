/**
 * Management Team permission catalog.
 * FULL_MANAGER_ACCESS enables all scoped manager permissions — never Super Admin powers.
 */

export const MANAGEMENT_ROLES = Object.freeze({
  PLATFORM_MANAGER: "platform_manager",
  SHOP_MANAGER: "shop_manager",
  LOCATION_MANAGER: "location_manager",
});

export const MANAGEMENT_ROLE_LABELS = Object.freeze({
  platform_manager: "Platform Manager",
  shop_manager: "Shop Manager",
  location_manager: "Location Manager",
});

export const MANAGEMENT_STATUSES = Object.freeze({
  ACTIVE: "active",
  SUSPENDED: "suspended",
  REMOVED: "removed",
});

/** Permission keys toggled in the Admin UI. */
export const MANAGEMENT_PERMISSIONS = Object.freeze({
  FULL_MANAGER_ACCESS: "full_manager_access",
  MANAGE_STAFF: "manage_staff",
  ADD_STAFF: "add_staff",
  REMOVE_STAFF: "remove_staff",
  MANAGE_APPOINTMENTS: "manage_appointments",
  APPROVE_REJECT_BOOKINGS: "approve_reject_bookings",
  CANCEL_RESCHEDULE_APPOINTMENTS: "cancel_reschedule_appointments",
  MANAGE_SCHEDULES: "manage_schedules",
  MANAGE_AVAILABILITY: "manage_availability",
  MANAGE_SERVICES: "manage_services",
  MANAGE_PRICING: "manage_pricing",
  MANAGE_SHOP_PROFILE: "manage_shop_profile",
  MANAGE_LOCATIONS: "manage_locations",
  MANAGE_PORTFOLIOS: "manage_portfolios",
  MANAGE_REVIEWS: "manage_reviews",
  RESPOND_TO_REVIEWS: "respond_to_reviews",
  MANAGE_CUSTOMERS: "manage_customers",
  VIEW_REPORTS: "view_reports",
  VIEW_SHOP_REVENUE: "view_shop_revenue",
  MANAGE_PROMOTIONS: "manage_promotions",
});

/** All normal management permissions (excludes Super Admin–only platform controls). */
export const SCOPED_MANAGER_PERMISSION_KEYS = Object.freeze(
  Object.values(MANAGEMENT_PERMISSIONS).filter((k) => k !== MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS),
);

export const PERMISSION_LABELS = Object.freeze({
  full_manager_access: "Full Manager Access",
  manage_staff: "Manage Staff",
  add_staff: "Add Staff",
  remove_staff: "Remove Staff",
  manage_appointments: "Manage Appointments",
  approve_reject_bookings: "Approve/Reject Bookings",
  cancel_reschedule_appointments: "Cancel/Reschedule Appointments",
  manage_schedules: "Manage Schedules",
  manage_availability: "Manage Availability/Off Days",
  manage_services: "Manage Services",
  manage_pricing: "Manage Pricing",
  manage_shop_profile: "Manage Shop Profile",
  manage_locations: "Manage Locations",
  manage_portfolios: "Manage Portfolios",
  manage_reviews: "Manage Reviews",
  respond_to_reviews: "Respond to Reviews",
  manage_customers: "Manage Customers",
  view_reports: "View Reports",
  view_shop_revenue: "View Shop Revenue/Booking Reports",
  manage_promotions: "Manage Promotions/Rewards",
});

/**
 * Super-Admin-only capabilities managers must never receive.
 * Enforced server-side; not exposeable via manager permission toggles.
 */
export const SUPER_ADMIN_ONLY_CAPABILITIES = Object.freeze([
  "platform_fee_config",
  "global_subscription_pricing",
  "platform_payment_credentials",
  "platform_secrets_env",
  "create_super_admin",
  "promote_to_super_admin",
  "suspend_super_admin",
  "remove_super_admin",
  "manage_management_team",
]);

export function isValidManagementRole(role) {
  return Object.values(MANAGEMENT_ROLES).includes(String(role || "").trim().toLowerCase());
}

export function normalizePermissionKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

export function isKnownPermissionKey(key) {
  const k = normalizePermissionKey(key);
  return Object.values(MANAGEMENT_PERMISSIONS).includes(k);
}

/**
 * Resolve effective permission set for a manager assignment.
 * full_manager_access expands to all scoped keys; never Super Admin capabilities.
 */
export function expandEffectivePermissions(permissionMap) {
  const map = permissionMap && typeof permissionMap === "object" ? permissionMap : {};
  const full = map[MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS] === true;
  const out = {};
  for (const key of SCOPED_MANAGER_PERMISSION_KEYS) {
    out[key] = full ? true : map[key] === true;
  }
  out[MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS] = full;
  return out;
}

export function hasEffectivePermission(permissionMap, permissionKey) {
  const key = normalizePermissionKey(permissionKey);
  if (!isKnownPermissionKey(key)) return false;
  const effective = expandEffectivePermissions(permissionMap);
  return effective[key] === true;
}

export function permissionCatalogForUi() {
  return Object.values(MANAGEMENT_PERMISSIONS).map((key) => ({
    key,
    label: PERMISSION_LABELS[key] || key,
    isFullAccess: key === MANAGEMENT_PERMISSIONS.FULL_MANAGER_ACCESS,
  }));
}
