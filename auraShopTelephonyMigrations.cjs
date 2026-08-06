/**
 * Additive shop-level telephony + AURA settings on businesses.
 * Platform number +19895141064 remains separate from per-shop Twilio lines.
 */
async function ensureAuraShopTelephonySchema(dbQuery) {
  if (typeof dbQuery !== "function") return { ok: false, reason: "no_db" };

  const cols = [
    [`public_phone_e164`, `TEXT`],
    [`twilio_phone_e164`, `TEXT`],
    [`twilio_phone_sid`, `TEXT`],
    [`owner_notification_phone_e164`, `TEXT`],
    [`manager_notification_phone_e164`, `TEXT`],
    [`escalation_phone_e164`, `TEXT`],
    [`business_email`, `TEXT`],
    [`timezone`, `TEXT`],
    [`voice_enabled`, `BOOLEAN DEFAULT TRUE`],
    [`sms_enabled`, `BOOLEAN DEFAULT TRUE`],
    [`aura_enabled`, `BOOLEAN DEFAULT TRUE`],
    [`aura_custom_greeting`, `TEXT`],
    [`aura_preferred_language`, `TEXT DEFAULT 'en'`],
    [`shop_code`, `TEXT`],
    [`aura_telephony_active`, `BOOLEAN DEFAULT TRUE`],
  ];

  for (const [name, type] of cols) {
    await dbQuery(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  // Backfill public_phone from legacy phone when empty
  await dbQuery(`
    UPDATE businesses
       SET public_phone_e164 = CASE
             WHEN phone ~ '^\\+1[0-9]{10}$' THEN phone
             WHEN regexp_replace(coalesce(phone,''), '\\D', '', 'g') ~ '^[0-9]{10}$'
               THEN '+1' || regexp_replace(phone, '\\D', '', 'g')
             WHEN regexp_replace(coalesce(phone,''), '\\D', '', 'g') ~ '^1[0-9]{10}$'
               THEN '+' || regexp_replace(phone, '\\D', '', 'g')
             ELSE public_phone_e164
           END
     WHERE (public_phone_e164 IS NULL OR btrim(public_phone_e164) = '')
       AND phone IS NOT NULL AND btrim(phone) <> ''
  `).catch(() => {});

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS businesses_twilio_phone_e164_uidx
      ON businesses (twilio_phone_e164)
      WHERE twilio_phone_e164 IS NOT NULL AND btrim(twilio_phone_e164) <> ''
  `).catch(() => {});

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS businesses_shop_code_uidx
      ON businesses (lower(shop_code))
      WHERE shop_code IS NOT NULL AND btrim(shop_code) <> ''
  `).catch(() => {});

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_shop_call_context_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      call_sid TEXT,
      from_e164 TEXT,
      to_e164 TEXT,
      shop_id BIGINT,
      identification_method TEXT,
      greeting_kind TEXT,
      detail JSONB
    )
  `);
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_shop_call_context_log_created_idx
     ON aura_shop_call_context_log (created_at DESC)`,
  );

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_shop_info_update_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      shop_id BIGINT,
      actor_role TEXT,
      actor_phone_masked TEXT,
      call_sid TEXT,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      verified BOOLEAN,
      success BOOLEAN,
      detail JSONB
    )
  `);

  return { ok: true };
}

module.exports = {
  ensureAuraShopTelephonySchema,
};
