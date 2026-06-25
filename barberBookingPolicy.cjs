/**
 * Shared rules for which barbers appear on customer-facing booking screens.
 */
const BARBER_BUSINESS_ID_SQL = `CASE
  WHEN b.business_id IS NOT NULL AND btrim(b.business_id) ~ '^[0-9]+$' THEN btrim(b.business_id)::bigint
  ELSE NULL
END`;

function shopChannelAccessSql(channel = "mobile") {
  const col = channel === "mobile" ? "mobile_app_access_enabled" : "website_access_enabled";
  return `(
    ${BARBER_BUSINESS_ID_SQL} IS NULL
    OR EXISTS (
      SELECT 1 FROM businesses biz
      WHERE biz.id = ${BARBER_BUSINESS_ID_SQL}
        AND COALESCE(biz.${col}, true) = true
        AND lower(coalesce(biz.approval_status, 'approved')) = 'approved'
        AND lower(coalesce(biz.account_status, 'active')) NOT IN ('suspended', 'disabled')
        AND COALESCE(biz.bookings_enabled, true) = true
    )
  )`;
}

/** SQL fragment — exclude QA / release-validation accounts from public booking. */
function qaTestAccountExcludeSql(barberAlias = "b") {
  const b = barberAlias;
  return `NOT (
    lower(coalesce(${b}.name, '')) LIKE '%release test%'
    OR lower(coalesce(${b}.name, '')) LIKE '%rv test%'
    OR lower(coalesce(${b}.name, '')) LIKE '%rv reject%'
    OR lower(coalesce(${b}.name, '')) LIKE '%qa multi%'
    OR lower(coalesce(${b}.name, '')) LIKE 'qa %'
    OR lower(coalesce(${b}.shop_name, '')) LIKE 'rv barber shop%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE 'rv reject shop%'
    OR lower(coalesce(${b}.shop_name, '')) LIKE 'rv business%'
    OR EXISTS (
      SELECT 1 FROM app_users qu
      WHERE qu.id = ${b}.user_id
        AND (
          lower(qu.email) LIKE 'rv-%'
          OR lower(qu.email) LIKE 'rv_%'
          OR lower(qu.email) LIKE 'release-%'
          OR lower(qu.email) LIKE 'qa-multi-%'
          OR lower(qu.email) LIKE 'qa-%'
          OR lower(coalesce(qu.name, '')) LIKE '%release test%'
          OR lower(coalesce(qu.name, '')) LIKE '%rv test%'
          OR lower(coalesce(qu.name, '')) LIKE '%rv reject%'
        )
    )
  )`;
}

/**
 * Barbers eligible for customer booking pickers and checkout.
 * @param {{ channel?: 'mobile' | 'website', barberAlias?: string }} [opts]
 */
function bookableBarberWhereSql(opts = {}) {
  const b = opts.barberAlias || "b";
  const channel = opts.channel || "mobile";
  return `
    lower(coalesce(${b}.verification_status, 'pending')) = 'approved'
    AND COALESCE(${b}.booking_hidden, false) = false
    AND ${shopChannelAccessSql(channel)}
    AND (
      ${b}.user_id IS NULL
      OR EXISTS (
        SELECT 1 FROM app_users u
        WHERE u.id = ${b}.user_id
          AND lower(coalesce(u.account_status, 'active')) = 'active'
          AND lower(coalesce(u.role, '')) = 'barber'
      )
    )
    AND ${qaTestAccountExcludeSql(b)}
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
    e.startsWith("qa-")
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
  shopChannelAccessSql,
  qaTestAccountExcludeSql,
  bookableBarberWhereSql,
  isQaTestLabel,
  isQaTestEmail,
  isBarberBookable,
};
