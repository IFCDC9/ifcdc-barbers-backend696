/**
 * JWT claims and API user shape for app_users auth.
 * Platform owner (service@ifcdc.org + super_admin in DB) gets role "admin" in JWT with owner flags.
 */
import { normalizeEmail } from "./authStore.js";
import { isSuperAdminEmail } from "./rolePolicy.js";

/**
 * @param {{ id: string, email?: string, role?: string, name?: string, full_name?: string, barber_id?: string | null, barberId?: string | null, business_id?: number | string | null, businessId?: number | null }} user — row from app_users
 */
export function jwtClaimsFromAppUser(user) {
  const email = normalizeEmail(user?.email);
  const dbRole = String(user?.role || "user").trim();
  const owner = isSuperAdminEmail(email) && dbRole === "super_admin";
  const isSuperAdmin = owner || dbRole === "super_admin";
  const biz = user?.business_id ?? user?.businessId;
  const businessIdNum = Number(biz);
  const businessId = Number.isFinite(businessIdNum) ? businessIdNum : null;
  const barberRaw = user?.barber_id ?? user?.barberId;
  const barberIdNum = Number(barberRaw);
  const barberId = barberRaw != null && String(barberRaw).trim() !== "" && Number.isFinite(barberIdNum) ? barberIdNum : barberRaw ?? null;
  return {
    id: user.id,
    sub: user.id,
    email: user.email,
    role: owner ? "admin" : dbRole,
    isOwner: Boolean(owner),
    isSuperAdmin: Boolean(isSuperAdmin),
    businessId,
    barberId,
  };
}

/**
 * @param {{ id: string, email?: string, role?: string, name?: string, full_name?: string, barber_id?: string | null, barberId?: string | null }} user
 */
export function publicUserFromAppUser(user) {
  const c = jwtClaimsFromAppUser(user);
  const createdAt = user?.created_at
    ? new Date(user.created_at).toISOString()
    : user?.createdAt
      ? new Date(user.createdAt).toISOString()
      : null;
  return {
    id: user.id,
    name: user.full_name ?? user.name,
    email: user.email,
    phone: user.phone ?? null,
    profileImageUrl: user.profile_image_url ?? user.profileImageUrl ?? null,
    dateOfBirth: user.date_of_birth
      ? String(user.date_of_birth).slice(0, 10)
      : user.dateOfBirth
        ? String(user.dateOfBirth).slice(0, 10)
        : null,
    role: c.role,
    barberId: user.barber_id ?? user.barberId ?? null,
    businessId: c.businessId,
    isOwner: c.isOwner,
    isSuperAdmin: c.isSuperAdmin,
    preferredLanguage: user.preferred_language ?? user.preferredLanguage ?? "en",
    createdAt,
  };
}

/** Global tenant bypass (shop routes, business scope): super_admin in JWT or explicit isSuperAdmin claim. */
export function isJwtGlobalSuperScope(user) {
  if (!user) return false;
  if (user.isSuperAdmin === true) return true;
  const r = String(user.role || "").trim().toLowerCase();
  return r === "super_admin";
}
