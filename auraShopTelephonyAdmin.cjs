/**
 * Admin read/write for shop telephone & AURA settings.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const { ensureAuraShopTelephonySchema } = require("./auraShopTelephonyMigrations.cjs");
const { formatUsDisplay, toE164OrNull, mapShopRow } = require("./auraShopContext.cjs");
const { getOfficialAuraBusinessE164 } = require("./auraVoiceIntelligenceFlags.cjs");

function e164OrNull(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = normalizeToE164(raw);
  return n.ok ? n.e164 : null;
}

function telephonyDto(row) {
  const shop = mapShopRow(row);
  if (!shop) return null;
  const platform = getOfficialAuraBusinessE164();
  return {
    shopId: shop.shopId,
    shopName: shop.shopName,
    publicPhoneNumber: shop.publicPhoneE164,
    publicPhoneDisplay: shop.publicPhoneDisplay,
    twilioPhoneNumber: shop.twilioPhoneE164,
    twilioPhoneNumberSid: shop.twilioPhoneSid,
    ownerNotificationPhone: shop.ownerNotificationPhone,
    managerNotificationPhone: shop.managerNotificationPhone,
    escalationPhone: shop.escalationPhone,
    businessEmail: shop.businessEmail,
    address: shop.address,
    timezone: shop.timezone,
    voiceEnabled: shop.voiceEnabled,
    smsEnabled: shop.smsEnabled,
    auraEnabled: shop.auraEnabled,
    customGreeting: shop.customGreeting,
    preferredLanguage: shop.preferredLanguage,
    shopCode: shop.shopCode,
    isActive: shop.telephonyActive && shop.isActive,
    telephonyActive: shop.telephonyActive,
    platformSharedNumber: platform,
    platformSharedDisplay: formatUsDisplay(platform),
    callTelHref: shop.publicPhoneE164
      ? `tel:${shop.publicPhoneE164}`
      : platform
        ? `tel:${platform}`
        : null,
  };
}

async function getShopTelephonySettings(dbQuery, shopId) {
  await ensureAuraShopTelephonySchema(dbQuery);
  const r = await dbQuery(
    `SELECT id, name, phone, address, city, state,
            public_phone_e164, twilio_phone_e164, twilio_phone_sid,
            owner_notification_phone_e164, manager_notification_phone_e164,
            escalation_phone_e164, business_email, timezone,
            voice_enabled, sms_enabled, aura_enabled, aura_custom_greeting,
            aura_preferred_language, shop_code, aura_telephony_active,
            account_status, approval_status
     FROM businesses WHERE id = $1::bigint LIMIT 1`,
    [Number(shopId)],
  );
  if (!r.rows?.[0]) return null;
  return telephonyDto(r.rows[0]);
}

/**
 * Patch telephony fields. Does not purchase/release Twilio numbers.
 * High-impact phone changes should be founder-gated by caller.
 */
async function updateShopTelephonySettings(dbQuery, shopId, patch = {}, { actor } = {}) {
  await ensureAuraShopTelephonySchema(dbQuery);
  const existing = await getShopTelephonySettings(dbQuery, shopId);
  if (!existing) return { ok: false, error: "shop_not_found" };

  const sets = [];
  const params = [];
  const push = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.publicPhoneNumber !== undefined || patch.publicPhoneE164 !== undefined) {
    push("public_phone_e164", e164OrNull(patch.publicPhoneNumber ?? patch.publicPhoneE164));
    // Keep legacy phone in sync for public config
    const pub = e164OrNull(patch.publicPhoneNumber ?? patch.publicPhoneE164);
    if (pub) push("phone", pub);
  }
  if (patch.twilioPhoneNumber !== undefined || patch.twilioPhoneE164 !== undefined) {
    push("twilio_phone_e164", e164OrNull(patch.twilioPhoneNumber ?? patch.twilioPhoneE164));
  }
  if (patch.twilioPhoneNumberSid !== undefined || patch.twilioPhoneSid !== undefined) {
    push("twilio_phone_sid", patch.twilioPhoneNumberSid ?? patch.twilioPhoneSid ?? null);
  }
  if (patch.ownerNotificationPhone !== undefined) {
    push("owner_notification_phone_e164", e164OrNull(patch.ownerNotificationPhone));
  }
  if (patch.managerNotificationPhone !== undefined) {
    push("manager_notification_phone_e164", e164OrNull(patch.managerNotificationPhone));
  }
  if (patch.escalationPhone !== undefined) {
    push("escalation_phone_e164", e164OrNull(patch.escalationPhone));
  }
  if (patch.businessEmail !== undefined) {
    push("business_email", String(patch.businessEmail || "").trim() || null);
  }
  if (patch.timezone !== undefined) {
    push("timezone", String(patch.timezone || "").trim() || "America/New_York");
  }
  if (patch.voiceEnabled !== undefined) push("voice_enabled", Boolean(patch.voiceEnabled));
  if (patch.smsEnabled !== undefined) push("sms_enabled", Boolean(patch.smsEnabled));
  if (patch.auraEnabled !== undefined) push("aura_enabled", Boolean(patch.auraEnabled));
  if (patch.telephonyActive !== undefined || patch.isActive !== undefined) {
    push("aura_telephony_active", Boolean(patch.telephonyActive ?? patch.isActive));
  }
  if (patch.customGreeting !== undefined) {
    push("aura_custom_greeting", String(patch.customGreeting || "").trim() || null);
  }
  if (patch.preferredLanguage !== undefined) {
    push("aura_preferred_language", String(patch.preferredLanguage || "en").trim() || "en");
  }
  if (patch.shopCode !== undefined) {
    push("shop_code", String(patch.shopCode || "").trim() || null);
  }
  if (patch.address !== undefined) push("address", String(patch.address || "").trim() || null);

  if (!sets.length) return { ok: true, settings: existing, unchanged: true };

  params.push(Number(shopId));
  try {
    await dbQuery(
      `UPDATE businesses SET ${sets.join(", ")} WHERE id = $${params.length}::bigint`,
      params,
    );
  } catch (e) {
    if (e?.code === "23505") {
      return { ok: false, error: "phone_or_code_conflict", message: "That Twilio number or shop code is already assigned." };
    }
    throw e;
  }

  const updated = await getShopTelephonySettings(dbQuery, shopId);
  console.log("[aura-shop-telephony] updated", {
    shopId: Number(shopId),
    actor: actor?.role || null,
    fields: Object.keys(patch),
  });
  return { ok: true, settings: updated };
}

function buildGreetingPreview(settings) {
  if (!settings) return null;
  if (settings.customGreeting) return settings.customGreeting;
  return `Thank you for calling ${settings.shopName}, powered by the IFCDC Barbers App. This is AURA. How may I assist you today?`;
}

module.exports = {
  getShopTelephonySettings,
  updateShopTelephonySettings,
  buildGreetingPreview,
  telephonyDto,
  e164OrNull,
  formatUsDisplay,
  toE164OrNull,
};
