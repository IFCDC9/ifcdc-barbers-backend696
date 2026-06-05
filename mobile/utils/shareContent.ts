/**
 * Native social-share helpers (Phase 1).
 *
 * Single source of truth for every Share button in the app. We rely solely on
 * the OS native share sheet (`react-native` `Share.share`) so the user can
 * pick any installed app — Facebook, Instagram, TikTok, X / Twitter, WhatsApp,
 * Messages, Mail, etc. — without us holding any social-network credentials,
 * tokens, or OAuth scope.
 *
 * Privacy / safety notes:
 * - Phase 1 is text-only (image sharing reserved for Phase 2).
 * - We never send personal customer data (name / email / phone) into the
 *   share message. Only the barber/shop name, service title, and a public
 *   marketing link.
 * - Booking IDs are deliberately excluded so a forwarded screenshot or
 *   pasted message cannot be used to look up someone else's appointment.
 */

import { Share, type ShareAction } from "react-native";

/** Brand label baked into every share message. */
export const APP_BRAND_NAME = "IFCDC Barbers";

/**
 * Public marketing URL for share messages.
 * Canonical: https://ifcdcbarbersapp.com (after GoDaddy DNS → Render).
 * Interim live SPA: Render frontend until DNS cutover.
 */
export const CANONICAL_LANDING_URL = "https://ifcdcbarbersapp.com";

/** Render SPA fallback when custom domain is unreachable. */
export const RENDER_LANDING_URL = "https://ifcdc-barbers-frontend.onrender.com";

export const APP_LANDING_URL =
  (typeof process !== "undefined" &&
    String(process.env.EXPO_PUBLIC_WEB_URL || process.env.EXPO_PUBLIC_LANDING_URL || "").trim()) ||
  CANONICAL_LANDING_URL;

const TAG_LINE = `Booked through ${APP_BRAND_NAME}`;
const FOOTER = `${TAG_LINE}\n${APP_LANDING_URL}`;

function clean(input: unknown, fallback = ""): string {
  if (input == null) return fallback;
  const s = String(input).trim();
  return s.length > 0 ? s : fallback;
}

function priceText(price: unknown): string | null {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toFixed(2)}`;
}

function durationText(minutes: unknown): string | null {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n)} min`;
}

/* ------------------------------------------------------------------------ */
/*  Message builders                                                         */
/* ------------------------------------------------------------------------ */

export interface BarberShareInput {
  barberName: string;
  shopName?: string | null;
  bio?: string | null;
}

/** Share a barber profile. */
export function buildBarberShareMessage(input: BarberShareInput): string {
  const name = clean(input.barberName, "this barber");
  const shop = clean(input.shopName);
  const bio = clean(input.bio);
  const lines = [`Check out ${name}${shop ? ` at ${shop}` : ""} on ${APP_BRAND_NAME}.`];
  if (bio) lines.push(bio);
  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n");
}

export interface ShopShareInput {
  shopName: string;
  city?: string | null;
  tagline?: string | null;
}

/** Share a shop profile. */
export function buildShopShareMessage(input: ShopShareInput): string {
  const name = clean(input.shopName, "this shop");
  const city = clean(input.city);
  const tagline = clean(input.tagline);
  const lines = [`Discover ${name}${city ? ` in ${city}` : ""} on ${APP_BRAND_NAME}.`];
  if (tagline) lines.push(tagline);
  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n");
}

export interface ServiceShareInput {
  serviceName: string;
  barberName?: string | null;
  shopName?: string | null;
  price?: number | string | null;
  durationMinutes?: number | string | null;
  description?: string | null;
}

/** Share an individual service / hairstyle card. */
export function buildServiceShareMessage(input: ServiceShareInput): string {
  const service = clean(input.serviceName, "this service");
  const barber = clean(input.barberName);
  const shop = clean(input.shopName);
  const desc = clean(input.description);
  const price = priceText(input.price);
  const duration = durationText(input.durationMinutes);

  const provider = barber || shop;
  const intro = provider
    ? `${service} with ${provider} on ${APP_BRAND_NAME}.`
    : `${service} on ${APP_BRAND_NAME}.`;

  const meta: string[] = [];
  if (price) meta.push(price);
  if (duration) meta.push(duration);

  const lines = [intro];
  if (meta.length > 0) lines.push(meta.join(" · "));
  if (desc) lines.push(desc);
  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n");
}

export interface BookingShareInput {
  serviceName?: string | null;
  barberName?: string | null;
  shopName?: string | null;
  /** Pre-formatted "May 25 at 2:30 PM" style string, or null/undefined. */
  whenLabel?: string | null;
}

/**
 * Share the just-completed booking confirmation. Intentionally omits booking
 * ID, payment details, and any customer info.
 */
export function buildBookingShareMessage(input: BookingShareInput): string {
  const service = clean(input.serviceName);
  const barber = clean(input.barberName);
  const shop = clean(input.shopName);
  const when = clean(input.whenLabel);

  const headline = service
    ? `Just booked ${service}${barber ? ` with ${barber}` : shop ? ` at ${shop}` : ""} on ${APP_BRAND_NAME}.`
    : `Just booked an appointment on ${APP_BRAND_NAME}.`;

  const lines = [headline];
  if (when) lines.push(when);
  if (!service && shop) lines.push(`At ${shop}.`);
  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n");
}

export interface ReceiptShareInput {
  serviceName?: string | null;
  barberName?: string | null;
  shopName?: string | null;
  whenLabel?: string | null;
}

/** Share a completed appointment / receipt — same shape as a booking share. */
export function buildReceiptShareMessage(input: ReceiptShareInput): string {
  const service = clean(input.serviceName);
  const barber = clean(input.barberName);
  const shop = clean(input.shopName);
  const when = clean(input.whenLabel);

  const headline = service && barber
    ? `Loved my ${service} with ${barber} on ${APP_BRAND_NAME}.`
    : service && shop
      ? `Loved my ${service} at ${shop} on ${APP_BRAND_NAME}.`
      : `Loved my appointment on ${APP_BRAND_NAME}.`;

  const lines = [headline];
  if (when) lines.push(when);
  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n");
}

/* ------------------------------------------------------------------------ */
/*  Native share sheet                                                       */
/* ------------------------------------------------------------------------ */

export interface ShareResult {
  /** True if the user actually completed a share (best-effort across OSes). */
  shared: boolean;
  /** True if user dismissed the sheet without sharing. */
  dismissed: boolean;
}

/**
 * Opens the OS native share sheet with the given message + optional dialog
 * title (Android) and subject (Email recipients on Android, Mail subject on
 * iOS). Errors are swallowed so a Share button never crashes the screen.
 */
export async function shareNatively(opts: {
  message: string;
  title?: string;
  subject?: string;
  url?: string;
}): Promise<ShareResult> {
  const message = clean(opts.message);
  if (!message) {
    return { shared: false, dismissed: true };
  }
  try {
    const action: ShareAction = await Share.share(
      {
        message,
        title: opts.title,
        ...(opts.url ? { url: opts.url } : {}),
      },
      {
        subject: opts.subject || opts.title,
        dialogTitle: opts.title || `Share via ${APP_BRAND_NAME}`,
      },
    );
    if (action.action === Share.dismissedAction) {
      return { shared: false, dismissed: true };
    }
    return { shared: true, dismissed: false };
  } catch (e) {
    if (__DEV__) {
      console.log(
        "[share] native share failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
    return { shared: false, dismissed: false };
  }
}
