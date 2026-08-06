/**
 * Multi-shop AURA telephony context — resolve shop from called number / shared routing.
 * Never invents shop data; never crosses tenant boundaries once shop is locked.
 */
const { normalizeToE164, maskPhoneForDisplay } = require("./smsPhone.cjs");
const {
  getOfficialAuraBusinessE164,
  OFFICIAL_AURA_BUSINESS_E164,
} = require("./auraVoiceIntelligenceFlags.cjs");
const { ensureAuraShopTelephonySchema } = require("./auraShopTelephonyMigrations.cjs");
const { isFounderCaller } = require("./auraFounderIdentity.cjs");

const PLATFORM_SHARED_E164 = OFFICIAL_AURA_BUSINESS_E164 || "+19895141064";

function toE164OrNull(raw) {
  const n = normalizeToE164(raw);
  return n.ok ? n.e164 : null;
}

function formatUsDisplay(e164) {
  const digits = String(e164 || "").replace(/\D/g, "");
  let n = digits;
  if (n.length === 11 && n.startsWith("1")) n = n.slice(1);
  if (n.length === 10) return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  return String(e164 || "").trim();
}

function mapShopRow(row) {
  if (!row) return null;
  const publicPhone =
    toE164OrNull(row.public_phone_e164) ||
    toE164OrNull(row.phone) ||
    null;
  const twilioPhone = toE164OrNull(row.twilio_phone_e164);
  return {
    shopId: Number(row.id),
    shopName: String(row.name || "").trim() || "Shop",
    publicPhoneE164: publicPhone,
    publicPhoneDisplay: publicPhone ? formatUsDisplay(publicPhone) : null,
    twilioPhoneE164: twilioPhone,
    twilioPhoneSid: row.twilio_phone_sid || null,
    ownerNotificationPhone: toE164OrNull(row.owner_notification_phone_e164),
    managerNotificationPhone: toE164OrNull(row.manager_notification_phone_e164),
    escalationPhone: toE164OrNull(row.escalation_phone_e164),
    businessEmail: row.business_email || null,
    address: [row.address, row.city, row.state].filter(Boolean).join(", ") || null,
    city: row.city || null,
    state: row.state || null,
    timezone: String(row.timezone || process.env.SHOP_TIMEZONE || "America/New_York").trim(),
    voiceEnabled: row.voice_enabled !== false,
    smsEnabled: row.sms_enabled !== false,
    auraEnabled: row.aura_enabled !== false,
    telephonyActive: row.aura_telephony_active !== false,
    customGreeting: row.aura_custom_greeting || null,
    preferredLanguage: row.aura_preferred_language || "en",
    shopCode: row.shop_code || null,
    isActive:
      String(row.account_status || "active").toLowerCase() !== "suspended" &&
      String(row.account_status || "active").toLowerCase() !== "disabled" &&
      String(row.approval_status || "approved").toLowerCase() !== "rejected",
  };
}

const SHOP_SELECT = `
  SELECT id, name, phone, address, city, state,
         public_phone_e164, twilio_phone_e164, twilio_phone_sid,
         owner_notification_phone_e164, manager_notification_phone_e164,
         escalation_phone_e164, business_email, timezone,
         voice_enabled, sms_enabled, aura_enabled, aura_custom_greeting,
         aura_preferred_language, shop_code, aura_telephony_active,
         account_status, approval_status
  FROM businesses
`;

async function loadShopById(dbQuery, shopId) {
  if (shopId == null || shopId === "") return null;
  try {
    await ensureAuraShopTelephonySchema(dbQuery);
    const r = await dbQuery(`${SHOP_SELECT} WHERE id = $1::bigint LIMIT 1`, [Number(shopId)]);
    return mapShopRow(r.rows?.[0]);
  } catch (e) {
    console.warn("[aura-shop] loadShopById:", e?.message || e);
    return null;
  }
}

async function resolveShopByTwilioTo(dbQuery, toRaw) {
  const to = toE164OrNull(toRaw);
  if (!to) return { shop: null, method: null, reason: "missing_to" };

  const platform = toE164OrNull(getOfficialAuraBusinessE164()) || PLATFORM_SHARED_E164;
  if (to === platform) {
    return { shop: null, method: "shared_platform_number", reason: "needs_shop_disambiguation", toE164: to };
  }

  try {
    await ensureAuraShopTelephonySchema(dbQuery);
    const r = await dbQuery(
      `${SHOP_SELECT}
       WHERE twilio_phone_e164 = $1
          OR public_phone_e164 = $1
          OR regexp_replace(coalesce(phone,''), '\\D', '', 'g')
             = regexp_replace($1, '\\D', '', 'g')
       LIMIT 1`,
      [to],
    );
    const shop = mapShopRow(r.rows?.[0]);
    if (!shop) return { shop: null, method: "unknown_called_number", reason: "no_shop_match", toE164: to };
    if (!shop.telephonyActive || !shop.isActive) {
      return { shop, method: "dedicated_inactive", reason: "shop_inactive", toE164: to };
    }
    if (!shop.auraEnabled || !shop.voiceEnabled) {
      return { shop, method: "dedicated_disabled", reason: "aura_or_voice_disabled", toE164: to };
    }
    return { shop, method: "dedicated_twilio_to", reason: null, toE164: to };
  } catch (e) {
    console.warn("[aura-shop] resolveShopByTwilioTo:", e?.message || e);
    return { shop: null, method: "lookup_error", reason: e?.message || String(e), toE164: to };
  }
}

async function resolveShopByCodeOrName(dbQuery, raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 80) return null;
  // Avoid treating full sentences / intents as shop names
  if (
    /\b(book|cancel|reschedule|human|agent|payment|schedule|hours|price|what changed|pin)\b/i.test(
      text,
    ) &&
    !/\b(shop|location|extension|code)\b/i.test(text)
  ) {
    return null;
  }
  try {
    await ensureAuraShopTelephonySchema(dbQuery);
    const code = text.match(/\b(?:shop|location|extension|code)\s*([A-Za-z0-9]{2,12})\b/i)?.[1];
    if (code) {
      const r = await dbQuery(
        `${SHOP_SELECT} WHERE lower(shop_code) = lower($1) LIMIT 1`,
        [code],
      );
      const shop = mapShopRow(r.rows?.[0]);
      if (shop) return { shop, method: "shop_code" };
    }
    // Prefer explicit "at/for/about <name>" or short name-only utterances
    const named =
      text.match(/\b(?:at|for|about|shop|location)\s+([A-Za-z0-9][A-Za-z0-9 '&-]{1,40})\b/i)?.[1] ||
      (/^[A-Za-z0-9][A-Za-z0-9 '&-]{1,40}$/.test(text) ? text : null);
    if (!named) return null;
    const r2 = await dbQuery(
      `${SHOP_SELECT}
       WHERE lower(name) = lower($1)
          OR lower(name) LIKE lower($2)
       ORDER BY CASE WHEN lower(name) = lower($1) THEN 0 ELSE 1 END, id ASC
       LIMIT 3`,
      [named.trim(), `%${named.trim()}%`],
    );
    const rows = (r2.rows || []).map(mapShopRow).filter(Boolean);
    if (rows.length === 1) return { shop: rows[0], method: "shop_name" };
    if (rows.length > 1) return { shop: null, method: "ambiguous_shop_name", candidates: rows };
    return null;
  } catch (e) {
    console.warn("[aura-shop] resolveShopByCodeOrName:", e?.message || e);
    return null;
  }
}

async function resolveShopFromCallerHistory(dbQuery, fromE164) {
  const from = toE164OrNull(fromE164);
  if (!from) return null;
  const digits = from.replace(/\D/g, "").slice(-10);
  try {
    const r = await dbQuery(
      `SELECT business_id
       FROM bookings
       WHERE deleted_at IS NULL
         AND business_id IS NOT NULL
         AND regexp_replace(coalesce(phone,''), '\\D', '', 'g') LIKE '%' || $1
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [digits],
    );
    const bid = r.rows?.[0]?.business_id;
    if (bid == null) return null;
    const shop = await loadShopById(dbQuery, bid);
    if (shop) return { shop, method: "returning_caller_booking" };
  } catch (e) {
    console.warn("[aura-shop] callerHistory:", e?.message || e);
  }
  return null;
}

async function listActiveAuraShops(dbQuery, { limit = 20 } = {}) {
  try {
    await ensureAuraShopTelephonySchema(dbQuery);
    const r = await dbQuery(
      `${SHOP_SELECT}
       WHERE coalesce(aura_enabled, true) = true
         AND coalesce(aura_telephony_active, true) = true
         AND lower(coalesce(account_status,'active')) NOT IN ('suspended','disabled')
       ORDER BY name ASC NULLS LAST
       LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 20, 1), 50)],
    );
    return (r.rows || []).map(mapShopRow).filter(Boolean);
  } catch (e) {
    console.warn("[aura-shop] listActiveAuraShops:", e?.message || e);
    return null;
  }
}

/**
 * Resolve shop context for an inbound voice call.
 * @returns {{
 *   shop: object|null,
 *   method: string,
 *   needsShopSelection: boolean,
 *   toE164: string|null,
 *   platformShared: boolean,
 *   inactive?: boolean,
 *   candidates?: object[],
 * }}
 */
async function resolveInboundShopContext(dbQuery, { to, from, preferredShopId } = {}) {
  const toE164 = toE164OrNull(to);
  const fromE164 = toE164OrNull(from);
  const platform = toE164OrNull(getOfficialAuraBusinessE164()) || PLATFORM_SHARED_E164;
  const platformShared = Boolean(toE164 && toE164 === platform);

  if (preferredShopId != null && preferredShopId !== "") {
    const shop = await loadShopById(dbQuery, preferredShopId);
    if (shop) {
      return {
        shop,
        method: "preferred_shop_id",
        needsShopSelection: false,
        toE164,
        platformShared,
      };
    }
  }

  const byTo = await resolveShopByTwilioTo(dbQuery, to);
  if (byTo.method === "dedicated_twilio_to" && byTo.shop) {
    return {
      shop: byTo.shop,
      method: byTo.method,
      needsShopSelection: false,
      toE164: byTo.toE164,
      platformShared: false,
    };
  }
  if (byTo.method === "dedicated_inactive" || byTo.method === "dedicated_disabled") {
    return {
      shop: byTo.shop,
      method: byTo.method,
      needsShopSelection: false,
      toE164: byTo.toE164,
      platformShared: false,
      inactive: true,
    };
  }
  if (byTo.method === "unknown_called_number") {
    return {
      shop: null,
      method: "unknown_called_number",
      needsShopSelection: true,
      toE164: byTo.toE164,
      platformShared: false,
    };
  }

  // Shared platform number — try returning caller, else ask
  if (platformShared || byTo.method === "shared_platform_number") {
    const hist = await resolveShopFromCallerHistory(dbQuery, fromE164);
    if (hist?.shop) {
      return {
        shop: hist.shop,
        method: hist.method,
        // History is a hint only — confirm shop name before locking tenant scope.
        needsShopSelection: true,
        toE164,
        platformShared: true,
        softMatch: true,
      };
    }
    return {
      shop: null,
      method: "shared_needs_selection",
      needsShopSelection: true,
      toE164,
      platformShared: true,
    };
  }

  return {
    shop: null,
    method: byTo.method || "unresolved",
    needsShopSelection: true,
    toE164,
    platformShared,
  };
}

function buildShopGreeting({ shop, platformShared, founder, needsShopSelection, inactive } = {}) {
  if (founder) {
    return "Welcome back, Mister Allah. This is AURA. I have the latest I F C D C Barbers App information available. Would you like the platform-wide summary or information for a specific shop?";
  }
  if (inactive && shop) {
    return `You've reached ${shop.shopName}, but voice booking is not active for this location right now. Please try the I F C D C Barbers App, or call back later.`;
  }
  if (shop && !needsShopSelection) {
    if (shop.customGreeting && String(shop.customGreeting).trim()) {
      return String(shop.customGreeting).trim();
    }
    return `Thank you for calling ${shop.shopName}, powered by the I F C D C Barbers App. This is AURA. How may I assist you today?`;
  }
  if (platformShared || needsShopSelection) {
    return "Thank you for calling the I F C D C Barbers App. This is AURA. Which shop or location may I assist you with today?";
  }
  return "Thank you for calling the I F C D C Barbers App. This is AURA. How may I help you?";
}

const SHOP_SELECT_PROMPT =
  "Which I F C D C Barbers App location or shop are you calling about?";

async function logShopCallContext(dbQuery, row) {
  if (typeof dbQuery !== "function") return;
  try {
    await ensureAuraShopTelephonySchema(dbQuery);
    await dbQuery(
      `INSERT INTO aura_shop_call_context_log
         (call_sid, from_e164, to_e164, shop_id, identification_method, greeting_kind, detail)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::jsonb)`,
      [
        row.callSid || null,
        row.fromE164 || null,
        row.toE164 || null,
        row.shopId ?? null,
        row.method || null,
        row.greetingKind || null,
        JSON.stringify(row.detail || {}),
      ],
    );
  } catch (e) {
    console.warn("[aura-shop] context log:", e?.message || e);
  }
}

async function auditShopInfoUpdate(dbQuery, row) {
  if (typeof dbQuery !== "function") return null;
  try {
    await ensureAuraShopTelephonySchema(dbQuery);
    const ins = await dbQuery(
      `INSERT INTO aura_shop_info_update_audit
         (shop_id, actor_role, actor_phone_masked, call_sid, field_name, old_value, new_value, verified, success, detail)
       VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING id`,
      [
        row.shopId ?? null,
        row.actorRole || null,
        row.actorPhone ? maskPhoneForDisplay(row.actorPhone) : null,
        row.callSid || null,
        String(row.fieldName || "unknown").slice(0, 80),
        row.oldValue != null ? String(row.oldValue).slice(0, 500) : null,
        row.newValue != null ? String(row.newValue).slice(0, 500) : null,
        Boolean(row.verified),
        Boolean(row.success),
        JSON.stringify(row.detail || {}),
      ],
    );
    return ins.rows?.[0]?.id || null;
  } catch (e) {
    console.warn("[aura-shop] update audit:", e?.message || e);
    return null;
  }
}

/** Assert barber belongs to shop — tenant isolation gate. */
async function assertBarberInShop(dbQuery, barberId, shopId) {
  if (shopId == null || barberId == null) return false;
  if (!Number.isFinite(Number(shopId))) return false;
  try {
    const r = await dbQuery(
      `SELECT id FROM barbers
       WHERE id::text = $1::text
         AND business_id = $2::bigint
       LIMIT 1`,
      [String(barberId), Number(shopId)],
    );
    return Boolean(r.rows?.[0]);
  } catch {
    return false;
  }
}

async function listBookableBarbersForShop(dbQuery, shopId, { limit = 12 } = {}) {
  if (shopId == null) return [];
  const { isBarberBookable } = require("./barberBookingPolicy.cjs");
  try {
    const r = await dbQuery(
      `SELECT id, name FROM barbers
       WHERE business_id = $1::bigint
         AND coalesce(booking_hidden, false) = false
       ORDER BY name ASC NULLS LAST
       LIMIT 40`,
      [Number(shopId)],
    );
    const out = [];
    for (const row of r.rows || []) {
      try {
        if (await isBarberBookable(dbQuery, row.id, { channel: "mobile" })) {
          out.push({ id: row.id, name: String(row.name || "").trim() });
        }
      } catch {
        /* skip */
      }
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    console.warn("[aura-shop] listBookableBarbersForShop:", e?.message || e);
    return null;
  }
}

module.exports = {
  PLATFORM_SHARED_E164,
  formatUsDisplay,
  toE164OrNull,
  mapShopRow,
  loadShopById,
  resolveShopByTwilioTo,
  resolveShopByCodeOrName,
  resolveShopFromCallerHistory,
  resolveInboundShopContext,
  listActiveAuraShops,
  buildShopGreeting,
  SHOP_SELECT_PROMPT,
  logShopCallContext,
  auditShopInfoUpdate,
  assertBarberInShop,
  listBookableBarbersForShop,
  isFounderCaller,
};
