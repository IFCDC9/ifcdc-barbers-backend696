/**
 * Shared rules for which barbers appear on customer-facing booking screens
 * (website + iOS/Android). Keep this file as the single source of truth.
 */
/** Positive numeric shop ids only — legacy `0` / empty placeholders are treated as unassigned. */
const BARBER_BUSINESS_ID_SQL = `CASE
  WHEN b.business_id IS NOT NULL AND btrim(b.business_id) ~ '^[1-9][0-9]*$' THEN btrim(b.business_id)::bigint
  ELSE NULL
END`;

/** Platform house provider — the only bookable row without a linked approved shop + barber user. */
function platformHouseBarberSql(barberAlias = "b") {
  const b = barberAlias;
  return `(
    lower(btrim(coalesce(${b}.business_id, ''))) = 'default'
    OR lower(btrim(coalesce(${b}.name, ''))) = 'ifcdc barbers'
  )`;
}

function shopChannelAccessSql(channel = "mobile") {
  const col = channel === "mobile" ? "mobile_app_access_enabled" : "website_access_enabled";
  return `EXISTS (
    SELECT 1 FROM businesses biz
    WHERE biz.id = ${BARBER_BUSINESS_ID_SQL}
      AND COALESCE(biz.${col}, true) = true
      AND lower(coalesce(biz.approval_status, 'approved')) = 'approved'
      AND lower(coalesce(biz.account_status, 'active')) NOT IN ('suspended', 'disabled')
      AND COALESCE(biz.bookings_enabled, true) = true
  )`;
}

function activeBarberUserSql(barberAlias = "b") {
  const b = barberAlias;
  return `EXISTS (
    SELECT 1 FROM app_users u
    WHERE u.id = ${b}.user_id
      AND lower(coalesce(u.account_status, 'active')) = 'active'
      AND lower(coalesce(u.role, '')) = 'barber'
  )`;
}

/** SQL fragment — exclude QA / demo / verify / seed accounts from public booking. */
function qaTestAccountExcludeSql(barberAlias = "b") {
  const b = barberAlias;
  return `NOT (
    lower(coalesce(${b}.name, '')) LIKE '%release test%'
    OR lower(coalesce(${b}.name, '')) LIKE '%rv test%'
    OR lower(coalesce(${b}.name, '')) LIKE '%rv reject%'
    OR lower(coalesce(${b}.name, '')) LIKE '%qa multi%'
    OR lower(coalesce(${b}.name, '')) LIKE 'qa %'
    OR lower(coalesce(${b}.name, '')) LIKE '%verify%'
    OR lower(coalesce(${b}.name, '')) LIKE '%demo%'
    OR lower(coalesce(${b}.name, '')) LIKE '%placeholder%'
    OR lower(coalesce(${b}.name, '')) LIKE '%seed%'
    OR lower(coalesce(${b}.name, '')) LIKE 'test %'
    OR lower(coalesce(${b}.name, '')) LIKE '% test'
    OR lower(coalesce(${b}.name, '')) LIKE '%test barber%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE 'rv barber shop%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE 'rv reject shop%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE 'rv business%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE '%verify%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE '%demo%'
    OR EXISTS (
      SELECT 1 FROM app_users qu
      WHERE qu.id = ${b}.user_id
        AND (
          lower(qu.email) LIKE 'rv-%'
          OR lower(qu.email) LIKE 'rv_%'
          OR lower(qu.email) LIKE 'release-%'
          OR lower(qu.email) LIKE 'qa-multi-%'
          OR lower(qu.email) LIKE 'qa-%'
          OR lower(qu.email) LIKE 'verify-%'
          OR lower(qu.email) LIKE 'verify_%'
          OR lower(qu.email) LIKE '%@pipeline-test.%'
          OR lower(qu.email) LIKE '%.ifcdc.local'
          OR lower(coalesce(qu.name, '')) LIKE '%release test%'
          OR lower(coalesce(qu.name, '')) LIKE '%rv test%'
          OR lower(coalesce(qu.name, '')) LIKE '%rv reject%'
          OR lower(coalesce(qu.name, '')) LIKE '%verify%'
          OR lower(coalesce(qu.name, '')) LIKE '%demo%'
        )
    )
  )`;
}

/**
 * Barbers eligible for customer booking pickers and checkout.
 * Rules (website + mobile share this):
 * - Super Admin approved (`verification_status = approved`)
 * - Not booking-hidden
 * - Not QA / verify / demo / seed / placeholder
 * - Either the platform house provider (IFCDC Barbers), OR a real approved shop
 *   with channel access AND an active linked barber user account
 *
 * @param {{ channel?: 'mobile' | 'website', barberAlias?: string }} [opts]
 */
function bookableBarberWhereSql(opts = {}) {
  const b = opts.barberAlias || "b";
  const channel = opts.channel || "mobile";
  return `
    lower(coalesce(${b}.verification_status, 'pending')) = 'approved'
    AND COALESCE(${b}.booking_hidden, false) = false
    AND ${qaTestAccountExcludeSql(b)}
    AND (
      ${platformHouseBarberSql(b)}
      OR (
        ${BARBER_BUSINESS_ID_SQL} IS NOT NULL
        AND ${shopChannelAccessSql(channel)}
        AND ${b}.user_id IS NOT NULL
        AND ${activeBarberUserSql(b)}
      )
    )
  `;
}

function isQaTestLabel(value) {
  const s = String(value || "").toLowerCase();
  return (
    s.includes("release test") ||
    s.includes("rv test") ||
    s.includes("rv reject") ||
    s.includes("qa multi") ||
    /^qa /.test(s) ||
    s.includes("verify") ||
    s.includes("demo") ||
    s.includes("placeholder") ||
    s.includes("seed") ||
    /^test /.test(s) ||
    / test$/.test(s) ||
    s.includes("test barber") ||
    /^rv barber shop/.test(s) ||
    /^rv reject shop/.test(s) ||
    /^rv business/.test(s)
  );
}

function isQaTestEmail(email) {
  const e = String(email || "").toLowerCase();
  return (
    e.startsWith("rv-") ||
    e.startsWith("rv_") ||
    e.startsWith("release-") ||
    e.startsWith("qa-multi-") ||
    e.startsWith("qa-") ||
    e.startsWith("verify-") ||
    e.startsWith("verify_") ||
    e.includes("@pipeline-test.") ||
    e.endsWith(".ifcdc.local")
  );
}

/**
 * @param {*} dbQuery
 * @param {string|number} barberId
 * @param {{ channel?: 'mobile' | 'website' }} [opts]
 */
async function isBarberBookable(dbQuery, barberId, opts = {}) {
  if (barberId == null || String(barberId).trim() === "") return false;
  const r = await dbQuery(
    `SELECT 1 FROM barbers b WHERE b.id::text = $1::text AND ${bookableBarberWhereSql(opts)} LIMIT 1`,
    [String(barberId)],
  );
  return Boolean(r.rows?.length);
}

module.exports = {
  BARBER_BUSINESS_ID_SQL,
  platformHouseBarberSql,
  shopChannelAccessSql,
  qaTestAccountExcludeSql,
  bookableBarberWhereSql,
  isQaTestLabel,
  isQaTestEmail,
  isBarberBookable,
};
