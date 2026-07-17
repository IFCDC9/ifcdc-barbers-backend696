import { dbQuery, getDbPool } from "./db.js";

/** Five points per paid completed appointment matches the default 25-points/5-haircuts ladder. */
export const LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT = Math.max(
  1,
  Number(process.env.LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT || 5),
);

const PAID_STATUSES = new Set(["paid", "paid_full", "paid_in_full"]);
const REWARD_COLUMNS = `
  id, barber_id, business_id, reward_key, title, description, points_cost, reward_type, reward_value,
  eligible_services, eligible_barbers, expires_at, quantity_limit, quantity_redeemed,
  is_active, is_deleted, metadata, created_by, updated_by, created_at, updated_at
`;

function text(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(text).filter(Boolean);
    } catch {
      return value.split(",").map(text).filter(Boolean);
    }
  }
  return [];
}

function lowerSet(value) {
  return new Set(stringList(value).map((item) => item.toLowerCase()));
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function actorLabel(actor) {
  return text(actor?.email || actor?.name || actor?.role || actor?.id || actor || "system");
}

async function audit(client, {
  actor = "system",
  action,
  targetType,
  targetId = null,
  before = null,
  after = null,
  metadata = {},
} = {}) {
  await client.query(
    `INSERT INTO loyalty_audit_logs
       (actor_user_id, actor_label, action, target_type, target_id, before_data, after_data, metadata)
     VALUES (
       CASE WHEN $1::text ~* '^[0-9a-f-]{36}$' THEN $1::uuid ELSE NULL END,
       $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb
     )`,
    [
      text(actor?.id || ""),
      actorLabel(actor),
      text(action),
      text(targetType),
      targetId == null ? null : String(targetId),
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      JSON.stringify(metadata || {}),
    ],
  );
}

async function resolveUserId(client, booking) {
  if (booking?.user_id) return String(booking.user_id);
  const email = text(booking?.customer_email);
  if (!email) return null;
  const found = await client.query(
    `SELECT id FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
    [email],
  );
  return found.rows?.[0]?.id ? String(found.rows[0].id) : null;
}

async function ensureAccount(client, userId) {
  await client.query(
    `INSERT INTO loyalty_accounts (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const result = await client.query(
    `SELECT user_id, points_balance, lifetime_earned, lifetime_redeemed,
            completed_haircuts, points_debt, updated_at
     FROM loyalty_accounts WHERE user_id = $1::uuid FOR UPDATE`,
    [userId],
  );
  return result.rows[0];
}

export async function getOrCreateLoyaltyAccount(userId) {
  const uid = text(userId);
  if (!uid) return null;
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const account = await ensureAccount(client, uid);
    await client.query("COMMIT");
    return account;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (/loyalty_accounts.*does not exist/i.test(String(error?.message || error))) {
      return {
        user_id: uid,
        points_balance: 0,
        lifetime_earned: 0,
        lifetime_redeemed: 0,
        completed_haircuts: 0,
        points_debt: 0,
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listLoyaltyTransactions(userId, limit = 50) {
  const result = await dbQuery(
    `SELECT t.id, t.booking_id, t.redemption_id, t.delta, t.reason,
            t.transaction_type, t.metadata, t.created_at,
            r.status AS redemption_status, rw.title AS reward_title
     FROM loyalty_transactions t
     LEFT JOIN loyalty_redemptions r ON r.id = t.redemption_id
     LEFT JOIN loyalty_rewards rw ON rw.id = r.reward_id
     WHERE t.user_id = $1::uuid
     ORDER BY t.created_at DESC
     LIMIT $2`,
    [String(userId), Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return result.rows || [];
}

export async function listActiveRewards({ barberId = null } = {}) {
  const params = [];
  let scope = "barber_id IS NULL";
  let businessScope = "business_id IS NULL";
  if (barberId != null && text(barberId)) {
    params.push(text(barberId));
    scope = `(barber_id IS NULL OR barber_id = $1::text OR eligible_barbers @> to_jsonb(ARRAY[$1::text]))`;
    const business = await dbQuery(
      `SELECT business_id FROM barbers WHERE id::text = $1::text LIMIT 1`,
      [text(barberId)],
    ).catch(() => ({ rows: [] }));
    if (business.rows?.[0]?.business_id != null) {
      params.push(Number(business.rows[0].business_id));
      businessScope = `(business_id IS NULL OR business_id = $2)`;
    }
  }
  const result = await dbQuery(
    `SELECT ${REWARD_COLUMNS}
     FROM loyalty_rewards
     WHERE is_active = true
       AND is_deleted = false
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (quantity_limit IS NULL OR quantity_redeemed < quantity_limit)
       AND ${scope}
       AND ${businessScope}
     ORDER BY points_cost ASC, title ASC`,
    params,
  );
  return result.rows || [];
}

export async function listRewardsForBarberManage(barberId) {
  const result = await dbQuery(
    `SELECT ${REWARD_COLUMNS}
     FROM loyalty_rewards
     WHERE is_deleted = false AND (barber_id IS NULL OR barber_id = $1::text)
     ORDER BY points_cost ASC, title ASC`,
    [String(barberId)],
  );
  return result.rows || [];
}

export async function getLoyaltyDashboard(userId, { barberId = null } = {}) {
  const [account, transactions, rewards, redemptionResult] = await Promise.all([
    getOrCreateLoyaltyAccount(userId),
    listLoyaltyTransactions(userId, 100),
    listActiveRewards({ barberId }),
    dbQuery(
      `SELECT r.id, r.booking_id, r.points_spent, r.discount_amount, r.status,
              r.reserved_at, r.redeemed_at, r.restored_at, r.expires_at, r.created_at,
              rw.title, rw.description, rw.reward_type, rw.reward_value
       FROM loyalty_redemptions r
       JOIN loyalty_rewards rw ON rw.id = r.reward_id
       WHERE r.user_id = $1::uuid
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [String(userId)],
    ),
  ]);
  const points = Number(account?.points_balance) || 0;
  const availableRewards = rewards.filter((reward) => points >= Number(reward.points_cost || 0));
  const upcomingRewards = rewards.filter((reward) => points < Number(reward.points_cost || 0));
  const nextReward = upcomingRewards[0] || null;
  const previousThreshold = rewards
    .filter((reward) => Number(reward.points_cost) <= points)
    .reduce((max, reward) => Math.max(max, Number(reward.points_cost) || 0), 0);
  const nextThreshold = Number(nextReward?.points_cost) || previousThreshold || 1;
  const progressPercent = nextReward
    ? Math.max(0, Math.min(100, ((points - previousThreshold) / Math.max(1, nextThreshold - previousThreshold)) * 100))
    : 100;
  const redemptions = redemptionResult.rows || [];

  return {
    points,
    lifetimeEarned: Number(account?.lifetime_earned) || 0,
    lifetimeRedeemed: Number(account?.lifetime_redeemed) || 0,
    completedHaircuts: Number(account?.completed_haircuts) || 0,
    pointsDebt: Number(account?.points_debt) || 0,
    pointsPerHaircut: LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT,
    progressPercent: Math.round(progressPercent),
    nextReward,
    pointsToNextReward: nextReward ? Math.max(0, Number(nextReward.points_cost) - points) : 0,
    rewards,
    availableRewards,
    upcomingRewards,
    redeemedRewards: redemptions.filter((row) => row.status === "redeemed"),
    reservedRewards: redemptions.filter((row) => row.status === "reserved"),
    rewardHistory: redemptions,
    transactions,
  };
}

function bookingServices(booking) {
  if (Array.isArray(booking?.services_json)) return booking.services_json;
  if (typeof booking?.services_json === "string") {
    try {
      const parsed = JSON.parse(booking.services_json);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to legacy single-service shape.
    }
  }
  return [{
    id: booking?.style_id || booking?.service_id || booking?.service,
    name: booking?.service,
    price: Number(booking?.service_price ?? booking?.total_price ?? booking?.amount ?? 0),
  }];
}

function rewardEligibility(reward, booking) {
  if (
    reward?.business_id != null
    && booking?.business_id != null
    && String(reward.business_id) !== String(booking.business_id)
  ) {
    return { ok: false, message: "This reward belongs to a different shop." };
  }
  const allowedBarbers = lowerSet(reward?.eligible_barbers);
  if (allowedBarbers.size) {
    const barberValues = [booking?.barber_id, booking?.barber_name].map((v) => text(v).toLowerCase());
    if (!barberValues.some((value) => value && allowedBarbers.has(value))) {
      return { ok: false, message: "This reward is not eligible with the selected barber." };
    }
  }
  const allowedServices = lowerSet(reward?.eligible_services);
  const services = bookingServices(booking);
  if (allowedServices.size) {
    const match = services.some((service) => {
      const id = text(service?.id).toLowerCase();
      const name = text(service?.name).toLowerCase();
      return [...allowedServices].some(
        (allowed) =>
          (id && id === allowed)
          || (name && (name === allowed || name.includes(allowed) || allowed.includes(name))),
      );
    });
    if (!match) return { ok: false, message: "This reward is not eligible for the selected service." };
  }
  return { ok: true, services, allowedServices };
}

function calculateRewardDiscount(reward, booking, eligibility) {
  const subtotal = roundMoney(booking?.service_price ?? booking?.total_price ?? booking?.amount ?? 0);
  const type = text(reward?.reward_type).toLowerCase();
  const value = Math.max(0, Number(reward?.reward_value) || 0);
  let discount = 0;

  if (type === "discount_fixed") discount = value;
  else if (type === "discount_percent") discount = subtotal * Math.min(value, 100) / 100;
  else if (type === "free_service" || type === "free_standard_haircut") {
    const matching = eligibility.services.filter((service) => {
      if (!eligibility.allowedServices.size) return true;
      const id = text(service?.id).toLowerCase();
      const name = text(service?.name).toLowerCase();
      return [...eligibility.allowedServices].some(
        (allowed) =>
          (id && id === allowed)
          || (name && (name === allowed || name.includes(allowed) || allowed.includes(name))),
      );
    });
    discount = matching.length
      ? Math.max(...matching.map((service) => Number(service?.price) || 0))
      : 0;
    if (!discount && !eligibility.allowedServices.size) discount = subtotal;
    if (value > 0) discount = Math.min(discount || value, value);
  } else {
    // Custom packages/upgrades may reserve without a cash discount, or use reward_value.
    discount = value;
  }
  return roundMoney(Math.max(0, Math.min(subtotal, discount)));
}

export function evaluateRewardForBooking(reward, booking) {
  const eligibility = rewardEligibility(reward, booking);
  if (!eligibility.ok) return eligibility;
  return {
    ok: true,
    discountAmount: calculateRewardDiscount(reward, booking, eligibility),
  };
}

export async function reserveRewardForBooking({
  bookingId,
  rewardId,
  customerEmail,
  userId: authenticatedUserId = null,
  actor = "checkout",
} = {}) {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const bookingResult = await client.query(
      `SELECT id, user_id, customer_email, business_id, barber_id, barber_name, service, style_id,
              services_json, service_price, total_price, amount, booking_status, payment_status
       FROM bookings WHERE id = $1::uuid FOR UPDATE`,
      [String(bookingId)],
    );
    const booking = bookingResult.rows[0];
    if (!booking) throw new Error("Booking not found.");
    if (customerEmail && text(booking.customer_email).toLowerCase() !== text(customerEmail).toLowerCase()) {
      throw new Error("Reward account does not match this booking.");
    }

    const userId = await resolveUserId(client, booking);
    if (!userId) throw new Error("Sign in with your rewards account before applying a reward.");
    if (authenticatedUserId && String(authenticatedUserId) !== String(userId)) {
      throw new Error("The selected reward belongs to a different account.");
    }
    const account = await ensureAccount(client, userId);

    const rewardResult = await client.query(
      `SELECT ${REWARD_COLUMNS} FROM loyalty_rewards WHERE id = $1::uuid FOR UPDATE`,
      [String(rewardId)],
    );
    const reward = rewardResult.rows[0];
    if (!reward || !reward.is_active || reward.is_deleted) throw new Error("Reward not found or inactive.");
    if (reward.expires_at && new Date(reward.expires_at).getTime() <= Date.now()) throw new Error("This reward has expired.");
    const cost = Number(reward.points_cost) || 0;
    if (Number(account.points_balance) < cost) {
      throw new Error(`You need ${cost} points — you have ${Number(account.points_balance) || 0}.`);
    }
    const activeCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM loyalty_redemptions
       WHERE reward_id = $1::uuid AND status IN ('reserved', 'redeemed')`,
      [String(rewardId)],
    );
    if (reward.quantity_limit != null && Number(activeCount.rows[0]?.count) >= Number(reward.quantity_limit)) {
      throw new Error("This reward has reached its quantity limit.");
    }

    const evaluation = evaluateRewardForBooking(reward, booking);
    if (!evaluation.ok) throw new Error(evaluation.message);
    const discountAmount = evaluation.discountAmount;
    const redemption = await client.query(
      `INSERT INTO loyalty_redemptions
         (user_id, reward_id, booking_id, points_spent, discount_amount, status, reserved_at, expires_at, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'reserved', NOW(),
               LEAST(COALESCE($6::timestamptz, NOW() + INTERVAL '2 hours'), NOW() + INTERVAL '2 hours'),
               $7::jsonb)
       RETURNING *`,
      [
        userId,
        String(rewardId),
        String(bookingId),
        cost,
        discountAmount,
        reward.expires_at || null,
        JSON.stringify({ rewardTitle: reward.title }),
      ],
    );
    const redemptionRow = redemption.rows[0];
    await client.query(
      `UPDATE loyalty_accounts
       SET points_balance = points_balance - $2, updated_at = NOW()
       WHERE user_id = $1::uuid`,
      [userId, cost],
    );
    await client.query(
      `INSERT INTO loyalty_transactions
         (user_id, booking_id, redemption_id, delta, reason, transaction_type, idempotency_key, created_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'reserve', $6, $7, $8::jsonb)`,
      [
        userId,
        String(bookingId),
        redemptionRow.id,
        -cost,
        `reserved:${reward.title}`,
        `reserve:booking:${bookingId}`,
        actorLabel(actor),
        JSON.stringify({ discountAmount }),
      ],
    );
    await client.query(
      `UPDATE bookings
       SET loyalty_redemption_id = $2::uuid,
           reward_discount_amount = $3,
           reward_title = $4
       WHERE id = $1::uuid`,
      [String(bookingId), redemptionRow.id, discountAmount, reward.title],
    );
    await audit(client, {
      actor,
      action: "reward_reserved",
      targetType: "redemption",
      targetId: redemptionRow.id,
      after: redemptionRow,
      metadata: { bookingId, rewardId, discountAmount },
    });
    await client.query("COMMIT");
    return { ok: true, redemption: redemptionRow, reward, discountAmount, userId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: error?.message || "Could not reserve reward." };
  } finally {
    client.release();
  }
}

export async function expireStaleRewardReservations() {
  const stale = await dbQuery(
    `SELECT r.booking_id
     FROM loyalty_redemptions r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.status = 'reserved'
       AND r.expires_at IS NOT NULL
       AND r.expires_at <= NOW()
       AND b.paypal_capture_id IS NULL
       AND b.payment_status NOT IN ('paid', 'paid_full', 'deposit_paid')
     ORDER BY r.expires_at ASC LIMIT 100`,
  );
  let restored = 0;
  for (const row of stale.rows || []) {
    if (!row.booking_id) continue;
    const result = await restoreRewardForBooking(row.booking_id, {
      actor: "reservation_expiry",
      reason: "checkout_reservation_expired",
    });
    if (result?.pointsRestored) restored += 1;
  }
  return { ok: true, restored };
}

export async function restoreRewardForBooking(bookingId, {
  actor = "system",
  reason = "booking_cancelled",
} = {}) {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT r.*, rw.title
       FROM loyalty_redemptions r
       JOIN loyalty_rewards rw ON rw.id = r.reward_id
       WHERE r.booking_id = $1::uuid AND r.status IN ('reserved', 'redeemed')
       ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE OF r`,
      [String(bookingId)],
    );
    const redemption = found.rows[0];
    if (!redemption) {
      await client.query("COMMIT");
      return { ok: true, skipped: true };
    }
    const account = await ensureAccount(client, redemption.user_id);
    await client.query(
      `UPDATE loyalty_redemptions
       SET status = 'restored', restored_at = NOW(), metadata = metadata || $2::jsonb
       WHERE id = $1::uuid`,
      [redemption.id, JSON.stringify({ restoreReason: reason })],
    );
    await client.query(
      `UPDATE loyalty_accounts
       SET points_balance = points_balance + $2,
           lifetime_redeemed = GREATEST(0, lifetime_redeemed - CASE WHEN $3 = 'redeemed' THEN $2 ELSE 0 END),
           updated_at = NOW()
       WHERE user_id = $1::uuid`,
      [redemption.user_id, Number(redemption.points_spent), redemption.status],
    );
    if (redemption.status === "redeemed") {
      await client.query(
        `UPDATE loyalty_rewards SET quantity_redeemed = GREATEST(0, quantity_redeemed - 1), updated_at = NOW()
         WHERE id = $1::uuid`,
        [redemption.reward_id],
      );
    }
    await client.query(
      `INSERT INTO loyalty_transactions
         (user_id, booking_id, redemption_id, delta, reason, transaction_type, idempotency_key, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'restore', $6, $7)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [
        redemption.user_id,
        String(bookingId),
        redemption.id,
        Number(redemption.points_spent),
        `restored:${redemption.title}`,
        `restore:booking:${bookingId}`,
        actorLabel(actor),
      ],
    );
    await audit(client, {
      actor,
      action: "reward_restored",
      targetType: "redemption",
      targetId: redemption.id,
      before: redemption,
      after: { ...redemption, status: "restored" },
      metadata: { bookingId, reason, previousBalance: Number(account.points_balance) },
    });
    await client.query("COMMIT");
    return { ok: true, pointsRestored: Number(redemption.points_spent), redemptionId: redemption.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function calculatePointsAward(client, booking) {
  const rules = await client.query(
    `SELECT points_per_completed_booking
     FROM loyalty_program_rules
     WHERE is_active = true
       AND (business_id IS NULL OR business_id = $1)
       AND (barber_id IS NULL OR barber_id = $2::text)
     ORDER BY
       CASE WHEN barber_id IS NOT NULL THEN 0 WHEN business_id IS NOT NULL THEN 1 ELSE 2 END,
       updated_at DESC
     LIMIT 1`,
    [booking?.business_id ?? null, booking?.barber_id == null ? null : String(booking.barber_id)],
  );
  const basePoints = Math.max(
    1,
    Number(rules.rows?.[0]?.points_per_completed_booking)
      || LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT,
  );
  const campaignsResult = await client.query(
    `SELECT id, name, points_multiplier, bonus_points
     FROM loyalty_campaigns
     WHERE is_active = true
       AND event_type IN ('completed_booking', 'double_points')
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at > NOW())
       AND (business_id IS NULL OR business_id = $1)
       AND (barber_id IS NULL OR barber_id = $2::text)
     ORDER BY created_at ASC`,
    [booking?.business_id ?? null, booking?.barber_id == null ? null : String(booking.barber_id)],
  );
  let multiplier = 1;
  let bonus = 0;
  for (const campaign of campaignsResult.rows || []) {
    multiplier *= Math.max(0, Number(campaign.points_multiplier) || 1);
    bonus += Math.max(0, Number(campaign.bonus_points) || 0);
  }
  return {
    points: Math.max(1, Math.floor(basePoints * multiplier + bonus)),
    basePoints,
    campaigns: (campaignsResult.rows || []).map((row) => ({
      id: row.id,
      name: row.name,
      multiplier: Number(row.points_multiplier),
      bonusPoints: Number(row.bonus_points),
    })),
  };
}

export async function earnLoyaltyForCompletedBooking(inputBooking) {
  const bookingId = text(inputBooking?.id);
  if (!bookingId) return { ok: false, reason: "missing_booking" };
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id, user_id, customer_email, business_id, booking_status, payment_status, is_paid_booking,
              refunded_at, barber_id, barber_name, service, services_json, total_price,
              service_price, amount, remaining_balance, balance_due, loyalty_redemption_id
       FROM bookings WHERE id = $1::uuid FOR UPDATE`,
      [bookingId],
    );
    const booking = found.rows[0];
    if (!booking) throw new Error("booking_not_found");
    const status = text(booking.booking_status).toLowerCase();
    const payment = text(booking.payment_status).toLowerCase();
    const depositSettled =
      payment === "deposit_paid"
      && Number(booking.remaining_balance ?? booking.balance_due ?? 0) <= 0.01;
    if (
      status !== "completed"
      || (!PAID_STATUSES.has(payment) && !depositSettled)
      || booking.refunded_at
      || payment.includes("refund")
    ) {
      await client.query("COMMIT");
      return { ok: false, reason: "booking_not_completed_and_paid" };
    }
    const userId = await resolveUserId(client, booking);
    if (!userId) {
      await client.query("COMMIT");
      return { ok: false, reason: "no_user" };
    }
    const account = await ensureAccount(client, userId);
    const pointsAward = await calculatePointsAward(client, booking);
    const inserted = await client.query(
      `INSERT INTO loyalty_transactions
         (user_id, booking_id, delta, reason, transaction_type, idempotency_key, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'booking_completed_paid', 'earn', $4, 'booking_completion')
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, bookingId, pointsAward.points, `earn:booking:${bookingId}`],
    );
    if (!inserted.rows.length) {
      await client.query("COMMIT");
      return { ok: true, deduped: true };
    }

    const debt = Number(account.points_debt) || 0;
    const debtPaid = Math.min(debt, pointsAward.points);
    const balanceAward = pointsAward.points - debtPaid;
    await client.query(
      `UPDATE loyalty_accounts
       SET points_balance = points_balance + $2,
           points_debt = GREATEST(0, points_debt - $3),
           lifetime_earned = lifetime_earned + $4,
           completed_haircuts = completed_haircuts + 1,
           updated_at = NOW()
       WHERE user_id = $1::uuid`,
      [userId, balanceAward, debtPaid, pointsAward.points],
    );

    let redemption = null;
    if (booking.loyalty_redemption_id) {
      const finalized = await client.query(
        `UPDATE loyalty_redemptions
         SET status = 'redeemed', redeemed_at = NOW()
         WHERE id = $1::uuid AND booking_id = $2::uuid AND status = 'reserved'
         RETURNING *`,
        [booking.loyalty_redemption_id, bookingId],
      );
      redemption = finalized.rows[0] || null;
      if (redemption) {
        await client.query(
          `UPDATE loyalty_rewards SET quantity_redeemed = quantity_redeemed + 1, updated_at = NOW()
           WHERE id = $1::uuid`,
          [redemption.reward_id],
        );
        await client.query(
          `UPDATE loyalty_accounts
           SET lifetime_redeemed = lifetime_redeemed + $2, updated_at = NOW()
           WHERE user_id = $1::uuid`,
          [userId, Number(redemption.points_spent)],
        );
        await audit(client, {
          actor: "booking_completion",
          action: "reward_redeemed",
          targetType: "redemption",
          targetId: redemption.id,
          after: redemption,
          metadata: { bookingId },
        });
      }
    }
    await audit(client, {
      actor: "booking_completion",
      action: "points_awarded",
      targetType: "booking",
      targetId: bookingId,
      after: { points: pointsAward.points, balanceAward, debtPaid },
      metadata: { userId, campaigns: pointsAward.campaigns },
    });
    await client.query("COMMIT");
    return {
      ok: true,
      userId,
      points: pointsAward.points,
      balanceAward,
      redemption,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function reverseLoyaltyForBooking(bookingId, {
  actor = "system",
  reason = "booking_refunded",
} = {}) {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const earned = await client.query(
      `SELECT * FROM loyalty_transactions
       WHERE booking_id = $1::uuid AND transaction_type = 'earn'
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [String(bookingId)],
    );
    const transaction = earned.rows[0];
    if (!transaction) {
      await client.query("COMMIT");
      await restoreRewardForBooking(bookingId, { actor, reason });
      return { ok: true, skipped: true };
    }
    const existing = await client.query(
      `SELECT id FROM loyalty_transactions WHERE idempotency_key = $1 LIMIT 1`,
      [`reverse:booking:${bookingId}`],
    );
    if (existing.rows.length) {
      await client.query("COMMIT");
      return { ok: true, deduped: true };
    }
    const account = await ensureAccount(client, transaction.user_id);
    const points = Math.abs(Number(transaction.delta) || 0);
    const available = Number(account.points_balance) || 0;
    const fromBalance = Math.min(available, points);
    const debtAdded = points - fromBalance;
    await client.query(
      `UPDATE loyalty_accounts
       SET points_balance = points_balance - $2,
           points_debt = points_debt + $3,
           lifetime_earned = GREATEST(0, lifetime_earned - $4),
           completed_haircuts = GREATEST(0, completed_haircuts - 1),
           updated_at = NOW()
       WHERE user_id = $1::uuid`,
      [transaction.user_id, fromBalance, debtAdded, points],
    );
    await client.query(
      `INSERT INTO loyalty_transactions
         (user_id, booking_id, delta, reason, transaction_type, idempotency_key, created_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'reversal', $5, $6, $7::jsonb)`,
      [
        transaction.user_id,
        String(bookingId),
        -points,
        reason,
        `reverse:booking:${bookingId}`,
        actorLabel(actor),
        JSON.stringify({ fromBalance, debtAdded }),
      ],
    );
    await audit(client, {
      actor,
      action: "points_reversed",
      targetType: "booking",
      targetId: bookingId,
      before: { pointsBalance: available },
      after: { pointsBalance: available - fromBalance, debtAdded },
      metadata: { reason, points },
    });
    await client.query("COMMIT");
    await restoreRewardForBooking(bookingId, { actor, reason });
    return { ok: true, pointsReversed: points, debtAdded };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Direct redemption is intentionally disabled; rewards are reserved against a booking at checkout. */
export async function redeemLoyaltyReward() {
  return {
    ok: false,
    code: "checkout_reservation_required",
    message: "Choose this reward during booking checkout. Points are reserved then redeemed after completion.",
  };
}

function normalizeRewardPayload(payload) {
  const title = text(payload?.title ?? payload?.name);
  const pointsCost = Math.floor(Number(payload?.points_cost ?? payload?.pointsCost) || 0);
  const quantityLimit = numberOrNull(payload?.quantity_limit ?? payload?.quantityLimit);
  const expiresAt = text(payload?.expires_at ?? payload?.expirationDate) || null;
  if (!title) return { error: "Reward name is required." };
  if (pointsCost < 1) return { error: "Required points must be at least 1." };
  if (quantityLimit != null && quantityLimit < 1) return { error: "Quantity limit must be at least 1." };
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) return { error: "Expiration date is invalid." };
  return {
    title,
    description: text(payload?.description) || null,
    pointsCost,
    rewardType: text(payload?.reward_type ?? payload?.rewardType) || "custom",
    rewardValue: Math.max(0, Number(payload?.reward_value ?? payload?.rewardValue) || 0),
    eligibleServices: stringList(payload?.eligible_services ?? payload?.eligibleServices),
    eligibleBarbers: stringList(payload?.eligible_barbers ?? payload?.eligibleBarbers),
    expiresAt,
    quantityLimit,
    isActive: payload?.is_active ?? payload?.isActive ?? true,
    metadata: payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
  };
}

export async function upsertReward({
  payload,
  rewardId = null,
  barberId = null,
  businessId = null,
  actor = "admin",
} = {}) {
  const normalized = normalizeRewardPayload(payload);
  if (normalized.error) return { ok: false, message: normalized.error };
  const businessScope = businessId ?? payload?.business_id ?? payload?.businessId ?? null;
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    let before = null;
    let reward;
    if (rewardId) {
      const found = await client.query(
        `SELECT ${REWARD_COLUMNS} FROM loyalty_rewards WHERE id = $1::uuid AND is_deleted = false FOR UPDATE`,
        [String(rewardId)],
      );
      before = found.rows[0] || null;
      if (!before) throw new Error("Reward not found.");
      const updated = await client.query(
        `UPDATE loyalty_rewards
         SET barber_id = $2, business_id = $3, title = $4, description = $5, points_cost = $6,
             reward_type = $7, reward_value = $8, eligible_services = $9::jsonb,
             eligible_barbers = $10::jsonb, expires_at = $11, quantity_limit = $12,
             is_active = $13, metadata = $14::jsonb, updated_by = $15, updated_at = NOW()
         WHERE id = $1::uuid RETURNING ${REWARD_COLUMNS}`,
        [
          String(rewardId),
          barberId == null ? before.barber_id : String(barberId),
          businessScope == null ? before.business_id : Number(businessScope),
          normalized.title,
          normalized.description,
          normalized.pointsCost,
          normalized.rewardType,
          normalized.rewardValue,
          JSON.stringify(normalized.eligibleServices),
          JSON.stringify(normalized.eligibleBarbers),
          normalized.expiresAt,
          normalized.quantityLimit,
          Boolean(normalized.isActive),
          JSON.stringify(normalized.metadata),
          actorLabel(actor),
        ],
      );
      reward = updated.rows[0];
    } else {
      const inserted = await client.query(
        `INSERT INTO loyalty_rewards
           (barber_id, business_id, title, description, points_cost, reward_type, reward_value,
            eligible_services, eligible_barbers, expires_at, quantity_limit, is_active,
            metadata, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $14)
         RETURNING ${REWARD_COLUMNS}`,
        [
          barberId == null ? null : String(barberId),
          businessScope == null ? null : Number(businessScope),
          normalized.title,
          normalized.description,
          normalized.pointsCost,
          normalized.rewardType,
          normalized.rewardValue,
          JSON.stringify(normalized.eligibleServices),
          JSON.stringify(normalized.eligibleBarbers),
          normalized.expiresAt,
          normalized.quantityLimit,
          Boolean(normalized.isActive),
          JSON.stringify(normalized.metadata),
          actorLabel(actor),
        ],
      );
      reward = inserted.rows[0];
    }
    await audit(client, {
      actor,
      action: rewardId ? "reward_updated" : "reward_created",
      targetType: "reward",
      targetId: reward.id,
      before,
      after: reward,
    });
    await client.query("COMMIT");
    return { ok: true, reward };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: error?.message || "Could not save reward." };
  } finally {
    client.release();
  }
}

export async function upsertBarberReward(barberId, payload, rewardId = null, actor = "barber") {
  return upsertReward({ payload, rewardId, barberId, actor });
}

export async function deleteReward(rewardId, { barberId = null, actor = "admin" } = {}) {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const params = [String(rewardId)];
    let scope = "";
    if (barberId != null) {
      params.push(String(barberId));
      scope = "AND barber_id = $2::text";
    }
    const found = await client.query(
      `SELECT ${REWARD_COLUMNS} FROM loyalty_rewards
       WHERE id = $1::uuid ${scope} AND is_deleted = false FOR UPDATE`,
      params,
    );
    const before = found.rows[0];
    if (!before) throw new Error("Reward not found.");
    await client.query(
      `UPDATE loyalty_rewards
       SET is_deleted = true, is_active = false, updated_by = $2, updated_at = NOW()
       WHERE id = $1::uuid`,
      [String(rewardId), actorLabel(actor)],
    );
    await audit(client, {
      actor,
      action: "reward_deleted",
      targetType: "reward",
      targetId: rewardId,
      before,
      after: { ...before, is_deleted: true, is_active: false },
    });
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: error?.message || "Could not delete reward." };
  } finally {
    client.release();
  }
}

export async function deleteBarberReward(barberId, rewardId, actor = "barber") {
  return deleteReward(rewardId, { barberId, actor });
}

export async function manualLoyaltyAdjustment(userId, delta, {
  actor = "admin",
  reason = "manual_adjustment",
  metadata = {},
} = {}) {
  const amount = Math.trunc(Number(delta) || 0);
  if (!amount) return { ok: false, message: "Adjustment must be a non-zero whole number." };
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const account = await ensureAccount(client, String(userId));
    const nextBalance = Number(account.points_balance) + amount;
    if (nextBalance < 0) throw new Error("Adjustment would make the points balance negative.");
    await client.query(
      `UPDATE loyalty_accounts SET points_balance = $2, updated_at = NOW() WHERE user_id = $1::uuid`,
      [String(userId), nextBalance],
    );
    const transaction = await client.query(
      `INSERT INTO loyalty_transactions
         (user_id, delta, reason, transaction_type, created_by, metadata)
       VALUES ($1::uuid, $2, $3, 'manual_adjustment', $4, $5::jsonb)
       RETURNING *`,
      [String(userId), amount, text(reason), actorLabel(actor), JSON.stringify(metadata || {})],
    );
    await audit(client, {
      actor,
      action: "manual_adjustment",
      targetType: "loyalty_account",
      targetId: userId,
      before: account,
      after: { ...account, points_balance: nextBalance },
      metadata: { delta: amount, reason },
    });
    await client.query("COMMIT");
    return { ok: true, account: { ...account, points_balance: nextBalance }, transaction: transaction.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: error?.message || "Adjustment failed." };
  } finally {
    client.release();
  }
}

export async function getLoyaltyAdminReport({ limit = 20 } = {}) {
  const topLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const [summary, mostRedeemed, loyal, spenders, expired, adjustments, auditLogs] = await Promise.all([
    dbQuery(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'earn' THEN delta ELSE 0 END), 0)::int AS points_awarded,
        (SELECT COALESCE(SUM(points_spent), 0)::int
         FROM loyalty_redemptions WHERE status = 'redeemed') AS points_redeemed,
        (SELECT COUNT(*)::int FROM loyalty_redemptions WHERE status = 'redeemed') AS reward_redemptions,
        (SELECT COUNT(*)::int FROM loyalty_rewards
         WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND is_deleted = false) AS expired_rewards,
        (SELECT COALESCE(SUM(a.points_balance), 0)::int FROM loyalty_accounts a) AS reward_liability_points,
        (SELECT COALESCE(SUM(a.points_balance * COALESCE(v.avg_value_per_point, 0)), 0)
         FROM loyalty_accounts a
         CROSS JOIN (
           SELECT AVG(CASE WHEN points_cost > 0 THEN reward_value / points_cost ELSE 0 END) AS avg_value_per_point
           FROM loyalty_rewards WHERE is_active = true AND is_deleted = false
         ) v) AS reward_liability_value
      FROM loyalty_transactions
    `),
    dbQuery(
      `SELECT rw.id, rw.title, COUNT(*)::int AS redemptions,
              COALESCE(SUM(r.points_spent), 0)::int AS points_redeemed
       FROM loyalty_redemptions r JOIN loyalty_rewards rw ON rw.id = r.reward_id
       WHERE r.status = 'redeemed'
       GROUP BY rw.id, rw.title ORDER BY redemptions DESC, rw.title LIMIT $1`,
      [topLimit],
    ),
    dbQuery(
      `SELECT a.user_id, u.name, u.email, a.points_balance, a.lifetime_earned,
              a.lifetime_redeemed, a.completed_haircuts
       FROM loyalty_accounts a JOIN app_users u ON u.id = a.user_id
       ORDER BY a.completed_haircuts DESC, a.lifetime_earned DESC LIMIT $1`,
      [topLimit],
    ),
    dbQuery(
      `SELECT u.id AS user_id, u.name, u.email,
              COUNT(b.id)::int AS paid_bookings,
              COALESCE(SUM(COALESCE(b.total_paid, b.amount_paid, b.total_amount, 0)), 0) AS total_spent
       FROM app_users u JOIN bookings b
         ON b.user_id = u.id OR lower(trim(b.customer_email)) = lower(trim(u.email))
       WHERE b.payment_status IN ('paid', 'paid_full', 'paid_in_full', 'deposit_paid')
         AND b.booking_status = 'completed' AND b.refunded_at IS NULL
       GROUP BY u.id, u.name, u.email ORDER BY total_spent DESC LIMIT $1`,
      [topLimit],
    ),
    dbQuery(
      `SELECT ${REWARD_COLUMNS} FROM loyalty_rewards
       WHERE expires_at IS NOT NULL AND expires_at <= NOW() AND is_deleted = false
       ORDER BY expires_at DESC LIMIT $1`,
      [topLimit],
    ),
    dbQuery(
      `SELECT t.*, u.name, u.email FROM loyalty_transactions t
       JOIN app_users u ON u.id = t.user_id
       WHERE t.transaction_type = 'manual_adjustment'
       ORDER BY t.created_at DESC LIMIT $1`,
      [topLimit],
    ),
    dbQuery(`SELECT * FROM loyalty_audit_logs ORDER BY created_at DESC LIMIT $1`, [topLimit * 2]),
  ]);
  return {
    summary: summary.rows[0] || {},
    mostRedeemedRewards: mostRedeemed.rows || [],
    mostLoyalCustomers: loyal.rows || [],
    topSpendingCustomers: spenders.rows || [],
    expiredRewards: expired.rows || [],
    manualAdjustments: adjustments.rows || [],
    auditLogs: auditLogs.rows || [],
  };
}

export async function seedDefaultRewardsIfEmpty() {
  // Retire the original single-program sample offers after the tier engine is available.
  await dbQuery(
    `UPDATE loyalty_rewards
     SET is_active = false, updated_at = NOW(), updated_by = 'tier_migration'
     WHERE reward_key IS NULL
       AND barber_id IS NULL
       AND title IN ('$5 off next cut', '$10 off next cut', 'Free lineup add-on')`,
  );
  const defaults = [
    ["tier_25_lineup", 25, "Free Line-Up", "A complimentary line-up with an eligible appointment.", "free_service", 15, ["Line-Up", "Line Up", "Edge Up"]],
    ["tier_50_ten_off", 50, "$10 OFF", "$10 off any eligible service.", "discount_fixed", 10, []],
    ["tier_75_beard_upgrade", 75, "Free Beard Trim or Premium Upgrade", "Choose a free beard trim or barber-configured premium upgrade.", "free_service", 20, ["Beard Trim", "Premium Upgrade"]],
    ["tier_100_haircut", 100, "One FREE Standard Haircut", "One complimentary standard haircut.", "free_standard_haircut", 40, ["Standard Haircut", "Haircut"]],
    ["tier_125_treatment", 125, "Free Hair Wash or Conditioning Treatment", "Available when the selected barber offers the service.", "free_service", 20, ["Hair Wash", "Conditioning Treatment"]],
    ["tier_150_twenty_off", 150, "$20 OFF Premium Services", "$20 off eligible premium services.", "discount_fixed", 20, []],
    ["tier_200_vip", 200, "VIP Reward Package", "A VIP package configured by the shop administrator.", "vip_package", 50, []],
  ];
  for (const [key, points, title, description, type, value, services] of defaults) {
    await dbQuery(
      `INSERT INTO loyalty_rewards
         (barber_id, reward_key, title, description, points_cost, reward_type, reward_value,
          eligible_services, eligible_barbers, is_active, metadata)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7::jsonb, '[]'::jsonb, true, $8::jsonb)
       ON CONFLICT (reward_key) WHERE reward_key IS NOT NULL
       DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         points_cost = EXCLUDED.points_cost,
         reward_type = EXCLUDED.reward_type,
         reward_value = EXCLUDED.reward_value,
         eligible_services = EXCLUDED.eligible_services,
         updated_at = NOW()`,
      [
        key,
        title,
        description,
        points,
        type,
        value,
        JSON.stringify(services),
        JSON.stringify({ defaultTier: true, haircutsEquivalent: points / LOYALTY_POINTS_PER_COMPLETED_APPOINTMENT }),
      ],
    );
  }
}
