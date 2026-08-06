/**
 * Founder spoken shop-information updates (PIN + confirm + DB + audit).
 * Never logs or returns the Founder PIN.
 */
const { normalizeToE164 } = require("./smsPhone.cjs");
const {
  founderPinConfigured,
  founderPinMatches,
  isFounderCaller,
} = require("./auraFounderIdentity.cjs");
const { recordFounderActivity } = require("./auraFounderAudit.cjs");
const { auditShopInfoUpdate, loadShopById, formatUsDisplay } = require("./auraShopContext.cjs");
const {
  getShopTelephonySettings,
  updateShopTelephonySettings,
  e164OrNull,
} = require("./auraShopTelephonyAdmin.cjs");
const { ensureAuraShopTenantIsolation } = require("./auraShopTenantIsolationMigrations.cjs");

const UPDATE_INTENTS = [
  {
    field: "publicPhoneNumber",
    re: /\b(update|change|set)\b.+\b(phone|telephone|number)\b/i,
    label: "shop telephone number",
  },
  {
    field: "operatingHours",
    re: /\b(update|change|set)\b.+\b(business |shop |operating )?hours\b/i,
    label: "business hours",
  },
  {
    field: "holidayHours",
    re: /\b(update|change|set)\b.+\bholiday hours\b/i,
    label: "holiday hours",
  },
  {
    field: "address",
    re: /\b(update|change|set)\b.+\baddress\b/i,
    label: "shop address",
  },
  {
    field: "customGreeting",
    re: /\b(update|change|set)\b.+\b(greeting|welcome message)\b/i,
    label: "shop greeting",
  },
  {
    field: "preferredLanguage",
    re: /\b(update|change|set)\b.+\blanguage\b/i,
    label: "preferred language",
  },
  {
    field: "temporaryClosure",
    re: /\b(temporary(ily)? close|close (the )?shop|mark .+ closed|temporary closure)\b/i,
    label: "temporary closure",
  },
  {
    field: "reopenShop",
    re: /\b(reopen|open (the )?shop|end temporary closure)\b/i,
    label: "shop reopening",
  },
  {
    field: "ownerNotificationPhone",
    re: /\b(update|change|set)\b.+\b(owner|manager)?\s*notification (phone|number|contact)/i,
    label: "notification contact",
  },
  {
    field: "servicePrice",
    re: /\b(update|change|set)\b.+\b(price|pricing|cost)\b/i,
    label: "service price",
  },
  {
    field: "serviceDuration",
    re: /\b(update|change|set)\b.+\b(duration|minutes|how long)\b/i,
    label: "service duration",
  },
  {
    field: "serviceName",
    re: /\b(update|change|set|add)\b.+\bservices?\b/i,
    label: "services",
  },
  {
    field: "barberAvailability",
    re: /\b(update|change|set)\b.+\b(barber )?availability\b/i,
    label: "barber availability",
  },
];

function detectShopUpdateIntent(raw) {
  const text = String(raw || "").trim();
  for (const row of UPDATE_INTENTS) {
    if (row.re.test(text)) return row;
  }
  return null;
}

function extractQuotedOrAfterTo(raw) {
  const q = String(raw || "").match(/[“"]([^”"]+)[”"]/);
  if (q) return q[1].trim();
  const to = String(raw || "").match(/\bto\s+(.+)$/i);
  if (to) return to[1].replace(/[.?!]+$/, "").trim();
  return "";
}

/** Prefer full spoken hours text; avoid truncating "9 AM to 6 PM" at the word "to". */
function extractHoursValue(raw) {
  const text = String(raw || "").trim().replace(/[.?!]+$/, "");
  const q = text.match(/[“"]([^”"]+)[”"]/);
  if (q) return q[1].trim();
  const afterSet = text.match(
    /\b(?:set|change|update)\b(?:\s+(?:the|our|my))?\s+(?:business|shop|operating|holiday)?\s*hours\s+(?:to\s+)?(.+)$/i,
  );
  if (afterSet?.[1]) return afterSet[1].trim();
  // Plain value turn (not an "update … hours to …" command)
  if (!/\b(update|change|set)\b/i.test(text)) return text;
  const afterTo = extractQuotedOrAfterTo(text);
  return afterTo || text;
}

function speakHoursJson(value) {
  if (value == null) return "not set on the shop record";
  if (typeof value === "string") {
    try {
      return speakHoursJson(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (typeof value === "object") {
    if (value.note) return String(value.note);
    if (value.summary) return String(value.summary);
    if (value.barber_availability_note) return String(value.barber_availability_note);
  }
  return JSON.stringify(value);
}

function extractPhone(raw) {
  const n = normalizeToE164(raw);
  if (n.ok) return n.e164;
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function extractMoney(raw) {
  const m = String(raw || "").match(/\$?\s*(\d+(?:\.\d{1,2})?)\s*(dollars?)?/i);
  return m ? Number(m[1]) : null;
}

function extractMinutes(raw) {
  const m = String(raw || "").match(/(\d{1,3})\s*(minutes?|mins?|hour|hours)?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (/hour/i.test(m[2] || "")) n *= 60;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readCurrentValue(dbQuery, shopId, field) {
  await ensureAuraShopTenantIsolation(dbQuery).catch(() => {});
  const shop = await loadShopById(dbQuery, shopId);
  const tel = await getShopTelephonySettings(dbQuery, shopId);
  if (!shop || !tel) return { ok: false, error: "shop_not_found" };

  const r = await dbQuery(
    `SELECT operating_hours_json, holiday_hours_json, temporary_closed, temporary_closed_reason,
            temporary_closed_until, address, city, state
     FROM businesses WHERE id = $1::bigint LIMIT 1`,
    [Number(shopId)],
  );
  const row = r.rows?.[0] || {};

  switch (field) {
    case "publicPhoneNumber":
      return {
        ok: true,
        spoken: tel.publicPhoneDisplay || tel.publicPhoneNumber || "not set",
        raw: tel.publicPhoneNumber,
      };
    case "operatingHours":
      return {
        ok: true,
        spoken: speakHoursJson(row.operating_hours_json),
        raw: row.operating_hours_json,
      };
    case "holidayHours":
      return {
        ok: true,
        spoken: speakHoursJson(row.holiday_hours_json),
        raw: row.holiday_hours_json,
      };
    case "address":
      return {
        ok: true,
        spoken: [row.address, row.city, row.state].filter(Boolean).join(", ") || "not set",
        raw: row.address,
      };
    case "customGreeting":
      return { ok: true, spoken: tel.customGreeting || "default shop greeting", raw: tel.customGreeting };
    case "preferredLanguage":
      return { ok: true, spoken: tel.preferredLanguage || "en", raw: tel.preferredLanguage };
    case "temporaryClosure":
    case "reopenShop":
      return {
        ok: true,
        spoken: row.temporary_closed
          ? `temporarily closed${row.temporary_closed_reason ? `: ${row.temporary_closed_reason}` : ""}`
          : "open (not marked temporarily closed)",
        raw: Boolean(row.temporary_closed),
      };
    case "ownerNotificationPhone":
      return {
        ok: true,
        spoken: tel.ownerNotificationPhone
          ? formatUsDisplay(tel.ownerNotificationPhone)
          : "not set",
        raw: tel.ownerNotificationPhone,
      };
    default:
      return { ok: true, spoken: "available in live records", raw: null };
  }
}

async function applyShopFieldUpdate(dbQuery, { shopId, field, newValue, callSid, fromE164 }) {
  const before = await readCurrentValue(dbQuery, shopId, field);
  let success = false;
  let savedSpoken = "";

  try {
    if (field === "publicPhoneNumber") {
      const phone = e164OrNull(newValue) || extractPhone(String(newValue));
      if (!phone) return { ok: false, error: "invalid_phone" };
      const out = await updateShopTelephonySettings(dbQuery, shopId, { publicPhoneNumber: phone }, {
        actor: { role: "founder" },
      });
      success = Boolean(out.ok);
      savedSpoken = formatUsDisplay(phone);
    } else if (field === "customGreeting") {
      const out = await updateShopTelephonySettings(
        dbQuery,
        shopId,
        { customGreeting: String(newValue).trim() },
        { actor: { role: "founder" } },
      );
      success = Boolean(out.ok);
      savedSpoken = String(newValue).trim();
    } else if (field === "preferredLanguage") {
      const lang = /\bspanish|español|es\b/i.test(String(newValue)) ? "es" : "en";
      const out = await updateShopTelephonySettings(
        dbQuery,
        shopId,
        { preferredLanguage: lang },
        { actor: { role: "founder" } },
      );
      success = Boolean(out.ok);
      savedSpoken = lang === "es" ? "Spanish" : "English";
    } else if (field === "ownerNotificationPhone") {
      const phone = e164OrNull(newValue) || extractPhone(String(newValue));
      if (!phone) return { ok: false, error: "invalid_phone" };
      const out = await updateShopTelephonySettings(
        dbQuery,
        shopId,
        { ownerNotificationPhone: phone },
        { actor: { role: "founder" } },
      );
      success = Boolean(out.ok);
      savedSpoken = formatUsDisplay(phone);
    } else if (field === "address") {
      await dbQuery(`UPDATE businesses SET address = $2 WHERE id = $1::bigint`, [
        Number(shopId),
        String(newValue).trim(),
      ]);
      success = true;
      savedSpoken = String(newValue).trim();
    } else if (field === "operatingHours") {
      const payload = { note: String(newValue).trim(), updated_at: new Date().toISOString() };
      await dbQuery(`UPDATE businesses SET operating_hours_json = $2::jsonb WHERE id = $1::bigint`, [
        Number(shopId),
        JSON.stringify(payload),
      ]);
      success = true;
      savedSpoken = payload.note;
    } else if (field === "holidayHours") {
      const payload = { note: String(newValue).trim(), updated_at: new Date().toISOString() };
      await dbQuery(`UPDATE businesses SET holiday_hours_json = $2::jsonb WHERE id = $1::bigint`, [
        Number(shopId),
        JSON.stringify(payload),
      ]);
      success = true;
      savedSpoken = payload.note;
    } else if (field === "temporaryClosure") {
      await dbQuery(
        `UPDATE businesses SET temporary_closed = true, temporary_closed_reason = $2, temporary_closed_until = NULL
         WHERE id = $1::bigint`,
        [Number(shopId), String(newValue || "Temporarily closed by founder").slice(0, 240)],
      );
      success = true;
      savedSpoken = "temporarily closed";
    } else if (field === "reopenShop") {
      await dbQuery(
        `UPDATE businesses SET temporary_closed = false, temporary_closed_reason = NULL, temporary_closed_until = NULL
         WHERE id = $1::bigint`,
        [Number(shopId)],
      );
      success = true;
      savedSpoken = "reopened";
    } else if (field === "servicePrice" || field === "serviceDuration" || field === "serviceName") {
      const svc = await updateShopService(dbQuery, shopId, field, newValue);
      if (!svc.ok) return svc;
      success = true;
      savedSpoken = svc.spoken;
    } else if (field === "barberAvailability") {
      const av = await updateShopBarberAvailabilityNote(dbQuery, shopId, newValue);
      if (!av.ok) return av;
      success = true;
      savedSpoken = av.spoken;
    } else {
      return { ok: false, error: "unsupported_field" };
    }
  } catch (e) {
    await auditShopInfoUpdate(dbQuery, {
      shopId,
      actorRole: "founder",
      actorPhone: fromE164,
      callSid,
      fieldName: field,
      oldValue: before.spoken,
      newValue: String(newValue),
      verified: true,
      success: false,
      detail: { error: e?.message || String(e) },
    });
    return { ok: false, error: e?.message || String(e) };
  }

  await auditShopInfoUpdate(dbQuery, {
    shopId,
    actorRole: "founder",
    actorPhone: fromE164,
    callSid,
    fieldName: field,
    oldValue: before.spoken,
    newValue: savedSpoken,
    verified: true,
    success,
    detail: {},
  });
  await recordFounderActivity(dbQuery, {
    callSid,
    fromE164,
    eventKind: "protected_action_completed_or_denied",
    ok: success,
    detail: { field, shopId, savedSpoken },
  });

  // Re-read to confirm
  const after = await readCurrentValue(dbQuery, shopId, field === "reopenShop" ? "temporaryClosure" : field);
  return {
    ok: success,
    oldSpoken: before.spoken,
    newSpoken: savedSpoken,
    verifiedSpoken: after.spoken,
  };
}

async function updateShopService(dbQuery, shopId, field, newValue) {
  const nameHint =
    String(newValue).match(/\bfor\s+([A-Za-z][A-Za-z0-9 '&-]{1,40})/i)?.[1] ||
    String(newValue).match(/\b(service|named)\s+([A-Za-z][A-Za-z0-9 '&-]{1,40})/i)?.[2] ||
    null;
  const price = extractMoney(newValue);
  const minutes = extractMinutes(newValue);

  const barbers = await dbQuery(
    `SELECT id, name FROM barbers WHERE business_id = $1::bigint LIMIT 20`,
    [Number(shopId)],
  );
  if (!barbers.rows?.length) return { ok: false, error: "no_barbers_in_shop" };

  // Prefer barber_services rows for this shop's barbers
  let svcRow = null;
  if (nameHint) {
    const r = await dbQuery(
      `SELECT s.id, s.name, s.price, s.duration_minutes, s.barber_id
       FROM barber_services s
       JOIN barbers b ON b.id::text = s.barber_id::text
       WHERE b.business_id = $1::bigint
         AND lower(s.name) LIKE lower($2)
         AND coalesce(s.is_active, true) = true
       LIMIT 1`,
      [Number(shopId), `%${nameHint}%`],
    );
    svcRow = r.rows?.[0] || null;
  }
  if (!svcRow) {
    const r = await dbQuery(
      `SELECT s.id, s.name, s.price, s.duration_minutes, s.barber_id
       FROM barber_services s
       JOIN barbers b ON b.id::text = s.barber_id::text
       WHERE b.business_id = $1::bigint AND coalesce(s.is_active, true) = true
       ORDER BY s.name ASC LIMIT 1`,
      [Number(shopId)],
    );
    svcRow = r.rows?.[0] || null;
  }
  if (!svcRow) return { ok: false, error: "service_not_found" };

  if (field === "servicePrice") {
    if (price == null) return { ok: false, error: "missing_price" };
    await dbQuery(`UPDATE barber_services SET price = $2 WHERE id = $1`, [svcRow.id, price]);
    return { ok: true, spoken: `${svcRow.name} price ${price} dollars` };
  }
  if (field === "serviceDuration") {
    if (minutes == null) return { ok: false, error: "missing_duration" };
    await dbQuery(`UPDATE barber_services SET duration_minutes = $2 WHERE id = $1`, [svcRow.id, minutes]);
    return { ok: true, spoken: `${svcRow.name} duration ${minutes} minutes` };
  }
  // serviceName — rename or note
  const newName = extractQuotedOrAfterTo(newValue) || nameHint;
  if (!newName) return { ok: false, error: "missing_service_name" };
  await dbQuery(`UPDATE barber_services SET name = $2 WHERE id = $1`, [svcRow.id, newName]);
  return { ok: true, spoken: `service renamed to ${newName}` };
}

async function updateShopBarberAvailabilityNote(dbQuery, shopId, newValue) {
  const note = String(newValue || "").trim();
  // Store as metadata on first barber settings when possible; also stamp shop hours note
  await dbQuery(
    `UPDATE businesses SET operating_hours_json = COALESCE(operating_hours_json, '{}'::jsonb) || $2::jsonb
     WHERE id = $1::bigint`,
    [Number(shopId), JSON.stringify({ barber_availability_note: note, updated_at: new Date().toISOString() })],
  );
  return { ok: true, spoken: note };
}

/**
 * Drive founder update FSM on session.
 * session.infoUpdate = { step, field, label, oldSpoken, newValue }
 */
async function handleFounderShopUpdateTurn({
  dbQuery,
  callSid,
  fromE164,
  raw,
  session,
} = {}) {
  if (!isFounderCaller(fromE164)) {
    return {
      handled: true,
      reply: "Only the verified Founder line may update shop information.",
      intent: "shop_update_denied",
    };
  }
  if (!session.shopId) {
    return {
      handled: true,
      reply: "Please switch to a shop first — for example, switch to the IFCDC Barbers shop.",
      intent: "shop_update_need_shop",
    };
  }

  // Active FSM
  if (session.infoUpdate?.step === "await_pin") {
    if (founderPinMatches(raw)) {
      session.ownerPinOk = true;
      session.infoUpdate.step = "await_new_value";
      await recordFounderActivity(dbQuery, {
        callSid,
        fromE164,
        eventKind: "owner_pin_verified",
        ok: true,
        detail: { for: "shop_update" },
      });
      return {
        handled: true,
        reply: `PIN verified. Current ${session.infoUpdate.label} is ${session.infoUpdate.oldSpoken}. Please say the new value.`,
        intent: "shop_update_pin_ok",
      };
    }
    await recordFounderActivity(dbQuery, {
      callSid,
      fromE164,
      eventKind: "owner_pin_verified",
      ok: false,
      detail: { for: "shop_update" },
    });
    return {
      handled: true,
      reply: "That PIN was not accepted. The shop information was not changed.",
      intent: "shop_update_pin_fail",
    };
  }

  if (session.infoUpdate?.step === "await_new_value") {
    let newValue = extractQuotedOrAfterTo(raw) || String(raw || "").trim();
    if (
      session.infoUpdate.field === "operatingHours" ||
      session.infoUpdate.field === "holidayHours" ||
      session.infoUpdate.field === "barberAvailability"
    ) {
      newValue = extractHoursValue(raw);
    }
    if (session.infoUpdate.field === "publicPhoneNumber" || session.infoUpdate.field === "ownerNotificationPhone") {
      newValue = extractPhone(raw) || newValue;
    }
    if (session.infoUpdate.field === "temporaryClosure") {
      newValue = extractQuotedOrAfterTo(raw) || String(raw || "").trim() || "Temporarily closed by founder";
    }
    if (session.infoUpdate.field === "reopenShop") {
      newValue = "reopen";
    }
    if (!newValue || newValue.length < 1) {
      return {
        handled: true,
        reply: `Please say the new ${session.infoUpdate.label}.`,
        intent: "shop_update_need_value",
      };
    }
    session.infoUpdate.newValue = newValue;
    session.infoUpdate.step = "await_confirm";
    const displayNew =
      session.infoUpdate.field.includes("Phone") && extractPhone(String(newValue))
        ? formatUsDisplay(extractPhone(String(newValue)))
        : newValue;
    return {
      handled: true,
      reply: `Please confirm: change ${session.infoUpdate.label} from ${session.infoUpdate.oldSpoken} to ${displayNew} for ${session.shopName}. Say yes to save, or no to cancel.`,
      intent: "shop_update_confirm",
    };
  }

  if (session.infoUpdate?.step === "await_confirm") {
    if (/\b(no|nope|cancel|stop)\b/i.test(raw)) {
      session.infoUpdate = null;
      return {
        handled: true,
        reply: "Okay — no changes were saved.",
        intent: "shop_update_cancelled",
      };
    }
    if (!/\b(yes|yeah|yep|confirm|save)\b/i.test(raw)) {
      return {
        handled: true,
        reply: "Say yes to save this change, or no to cancel.",
        intent: "shop_update_confirm_wait",
      };
    }
    const upd = await applyShopFieldUpdate(dbQuery, {
      shopId: session.shopId,
      field: session.infoUpdate.field,
      newValue: session.infoUpdate.newValue,
      callSid,
      fromE164,
    });
    const label = session.infoUpdate.label;
    session.infoUpdate = null;
    if (!upd.ok) {
      return {
        handled: true,
        reply: `I could not save that ${label}. ${upd.error || "Database update failed."} No change was confirmed.`,
        intent: "shop_update_failed",
      };
    }
    return {
      handled: true,
      reply: `Saved. ${label} for ${session.shopName} is now ${upd.verifiedSpoken || upd.newSpoken}. The database update succeeded.`,
      intent: "shop_update_ok",
    };
  }

  // New update request
  const intent = detectShopUpdateIntent(raw);
  if (!intent) return null;

  await recordFounderActivity(dbQuery, {
    callSid,
    fromE164,
    eventKind: "protected_action_requested",
    ok: true,
    detail: { field: intent.field, shopId: session.shopId },
  });

  const current = await readCurrentValue(dbQuery, session.shopId, intent.field);
  if (!current.ok) {
    return {
      handled: true,
      reply: "I could not load that shop field from live records. No change was made.",
      intent: "shop_update_read_failed",
    };
  }

  session.infoUpdate = {
    step: session.ownerPinOk ? "await_new_value" : "await_pin",
    field: intent.field,
    label: intent.label,
    oldSpoken: current.spoken,
    newValue: null,
  };

  // Inline new value if present (e.g. "change the phone number to 989-514-1064")
  const inlinePhone = extractPhone(raw);
  const inlineHours =
    intent.field === "operatingHours" || intent.field === "holidayHours"
      ? extractHoursValue(raw)
      : "";
  const inlineText =
    intent.field === "operatingHours" || intent.field === "holidayHours"
      ? (inlineHours && !/\b(update|change|set)\b.+\bhours\b\s*$/i.test(String(raw || "").trim())
          ? inlineHours
          : "")
      : extractQuotedOrAfterTo(raw);
  if (session.ownerPinOk && (inlinePhone || inlineText) && intent.field !== "temporaryClosure") {
    session.infoUpdate.newValue = inlinePhone || inlineText;
    session.infoUpdate.step = "await_confirm";
    const displayNew = inlinePhone ? formatUsDisplay(inlinePhone) : inlineText;
    return {
      handled: true,
      reply: `Current ${intent.label} is ${current.spoken}. Please confirm changing it to ${displayNew} for ${session.shopName}. Say yes to save, or no to cancel.`,
      intent: "shop_update_confirm",
    };
  }

  if (!session.ownerPinOk) {
    if (!founderPinConfigured()) {
      session.infoUpdate = null;
      return {
        handled: true,
        reply: "Protected shop updates require AURA_OWNER_VOICE_PIN to be configured. No change was made.",
        intent: "shop_update_pin_missing",
      };
    }
    return {
      handled: true,
      reply: `Current ${intent.label} is ${current.spoken}. Please say your Founder PIN to continue. I will not change anything until it is verified.`,
      intent: "shop_update_need_pin",
    };
  }

  return {
    handled: true,
    reply: `Current ${intent.label} is ${current.spoken}. Please say the new value.`,
    intent: "shop_update_need_value",
  };
}

module.exports = {
  UPDATE_INTENTS,
  detectShopUpdateIntent,
  handleFounderShopUpdateTurn,
  readCurrentValue,
  applyShopFieldUpdate,
};
