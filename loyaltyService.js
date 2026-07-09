import { dbQuery } from "./db.js";

/** Points earned per whole USD spent on completed bookings. */
export const LOYALTY_POINTS_PER_USD = Number(process.env.LOYALTY_POINTS_PER_USD || 1);

function pointsForBookingAmount(totalAmount) {
  const usd = Math.max(0, Number(totalAmount) || 0);
  return Math.max(1, Math.floor(usd * LOYALTY_POINTS_PER_USD));
}

export async function getOrCreateLoyaltyAccount(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  try {
    await dbQuery(
      `INSERT INTO loyalty_accounts (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING`,
      [uid],
    );
    const r = await dbQuery(
      `SELECT user_id, points_balance, lifetime_earned, updated_at
       FROM loyalty_accounts WHERE user_id = $1::uuid LIMIT 1`,
      [uid],
    );
    return r.rows?.[0] || { user_id: uid, points_balance: 0, lifetime_earned: 0 };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/loyalty_accounts/i.test(msg) && /does not exist/i.test(msg)) {
      return { user_id: uid, points_balance: 0, lifetime_earned: 0 };
    }
    throw e;
  }
}

export async function listLoyaltyTransactions(userId, limit = 30) {
  try {
    const r = await dbQuery(
      `SELECT id, booking_id, delta, reason, created_at
       FROM loyalty_transactions
       WHERE user_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2`,
      [String(userId), Math.min(Number(limit) || 30, 100)],
    );
    return r.rows || [];
  } catch (e) {
    const msg = String(e?.message || e);
    if (/loyalty_transactions/i.test(msg) && /does not exist/i.test(msg)) return [];
    throw e;
  }
}

export async function listActiveRewards({ barberId = null } = {}) {
  try {
    const params = [];
    let where = `is_active = true`;
    if (barberId != null && String(barberId).trim()) {
      params.push(String(barberId));
      where += ` AND (barber_id IS NULL OR barber_id = $${params.length}::text)`;
    } else {
      where += ` AND barber_id IS NULL`;
    }
    const r = await dbQuery(
      `SELECT id, barber_id, title, description, points_cost, is_active, created_at, updated_at
       FROM loyalty_rewards
       WHERE ${where}
       ORDER BY points_cost ASC, title ASC`,
      params,
    );
    return r.rows || [];
  } catch (e) {
    const msg = String(e?.message || e);
    if (/loyalty_rewards/i.test(msg) && /does not exist/i.test(msg)) return [];
    throw e;
  }
}

export async function listRewardsForBarberManage(barberId) {
  const r = await dbQuery(
    `SELECT id, barber_id, title, description, points_cost, is_active, created_at, updated_at
     FROM loyalty_rewards
     WHERE barber_id = $1::text
     ORDER BY points_cost ASC, title ASC`,
    [String(barberId)],
  );
  return r.rows || [];
}

export async function earnLoyaltyForCompletedBooking(booking) {
  const bookingId = booking?.id ? String(booking.id) : "";
  if (!bookingId) return { ok: false, reason: "missing_booking" };

  const userId = booking.user_id ? String(booking.user_id) : null;
  let resolvedUserId = userId;
  if (!resolvedUserId && booking.customer_email) {
    const u = await dbQuery(
      `SELECT id FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
      [String(booking.customer_email)],
    );
    resolvedUserId = u.rows?.[0]?.id ? String(u.rows[0].id) : null;
  }
  if (!resolvedUserId) return { ok: false, reason: "no_user" };

  const existing = await dbQuery(
    `SELECT id FROM loyalty_transactions WHERE booking_id = $1::uuid AND delta > 0 LIMIT 1`,
    [bookingId],
  );
  if (existing.rows?.length) return { ok: true, deduped: true };

  const points = pointsForBookingAmount(booking.total_amount ?? booking.total_price ?? booking.amount ?? 0);
  await dbQuery(
    `INSERT INTO loyalty_accounts (user_id, points_balance, lifetime_earned)
     VALUES ($1::uuid, $2, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       points_balance = loyalty_accounts.points_balance + EXCLUDED.points_balance,
       lifetime_earned = loyalty_accounts.lifetime_earned + EXCLUDED.lifetime_earned,
       updated_at = NOW()`,
    [resolvedUserId, points],
  );
  await dbQuery(
    `INSERT INTO loyalty_transactions (user_id, booking_id, delta, reason)
     VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [resolvedUserId, bookingId, points, "booking_completed"],
  );
  return { ok: true, userId: resolvedUserId, points };
}

export async function redeemLoyaltyReward(userId, rewardId) {
  const uid = String(userId || "").trim();
  const rid = String(rewardId || "").trim();
  if (!uid || !rid) return { ok: false, message: "Invalid request." };

  const rewardR = await dbQuery(
    `SELECT id, title, points_cost, is_active FROM loyalty_rewards WHERE id = $1::uuid LIMIT 1`,
    [rid],
  );
  const reward = rewardR.rows?.[0];
  if (!reward || !reward.is_active) return { ok: false, message: "Reward not found or inactive." };

  const cost = Number(reward.points_cost) || 0;
  if (cost <= 0) return { ok: false, message: "Invalid reward." };

  const account = await getOrCreateLoyaltyAccount(uid);
  const balance = Number(account?.points_balance) || 0;
  if (balance < cost) {
    return { ok: false, message: `You need ${cost} points — you have ${balance}.` };
  }

  await dbQuery(
    `UPDATE loyalty_accounts
     SET points_balance = points_balance - $2, updated_at = NOW()
     WHERE user_id = $1::uuid AND points_balance >= $2`,
    [uid, cost],
  );
  const redemption = await dbQuery(
    `INSERT INTO loyalty_redemptions (user_id, reward_id, points_spent, status)
     VALUES ($1::uuid, $2::uuid, $3, 'redeemed')
     RETURNING id, created_at`,
    [uid, rid, cost],
  );
  await dbQuery(
    `INSERT INTO loyalty_transactions (user_id, booking_id, delta, reason)
     VALUES ($1::uuid, NULL, $2, $3)`,
    [uid, -cost, `redeemed:${reward.title}`],
  );

  const refreshed = await getOrCreateLoyaltyAccount(uid);
  return {
    ok: true,
    redemption: redemption.rows?.[0] || null,
    account: refreshed,
    message: `Redeemed "${reward.title}" for ${cost} points.`,
  };
}

export async function upsertBarberReward(barberId, payload, rewardId = null) {
  const title = String(payload?.title || "").trim();
  const description = String(payload?.description || "").trim() || null;
  const pointsCost = Math.max(1, Math.floor(Number(payload?.points_cost ?? payload?.pointsCost) || 0));
  const isActive = payload?.is_active ?? payload?.isActive;
  if (!title) return { ok: false, message: "Title is required." };
  if (!pointsCost) return { ok: false, message: "Points cost must be at least 1." };

  if (rewardId) {
    const upd = await dbQuery(
      `UPDATE loyalty_rewards
       SET title = $3, description = $4, points_cost = $5,
           is_active = COALESCE($6, is_active), updated_at = NOW()
       WHERE id = $1::uuid AND barber_id = $2::text
       RETURNING *`,
      [
        String(rewardId),
        String(barberId),
        title,
        description,
        pointsCost,
        typeof isActive === "boolean" ? isActive : null,
      ],
    );
    if (!upd.rows?.length) return { ok: false, message: "Reward not found." };
    return { ok: true, reward: upd.rows[0] };
  }

  const ins = await dbQuery(
    `INSERT INTO loyalty_rewards (barber_id, title, description, points_cost, is_active)
     VALUES ($1::text, $2, $3, $4, COALESCE($5, true))
     RETURNING *`,
    [String(barberId), title, description, pointsCost, typeof isActive === "boolean" ? isActive : true],
  );
  return { ok: true, reward: ins.rows?.[0] };
}

export async function deleteBarberReward(barberId, rewardId) {
  const r = await dbQuery(
    `DELETE FROM loyalty_rewards WHERE id = $1::uuid AND barber_id = $2::text RETURNING id`,
    [String(rewardId), String(barberId)],
  );
  if (!r.rows?.length) return { ok: false, message: "Reward not found." };
  return { ok: true };
}

export async function seedDefaultRewardsIfEmpty() {
  const n = await dbQuery(`SELECT COUNT(*)::int AS c FROM loyalty_rewards`);
  if ((Number(n.rows?.[0]?.c) || 0) > 0) return;
  const defaults = [
    { title: "$5 off next cut", description: "Redeem on your next appointment.", points: 50 },
    { title: "$10 off next cut", description: "Save on premium services.", points: 100 },
    { title: "Free lineup add-on", description: "Complimentary edge-up with any service.", points: 75 },
  ];
  for (const row of defaults) {
    await dbQuery(
      `INSERT INTO loyalty_rewards (barber_id, title, description, points_cost, is_active)
       VALUES (NULL, $1, $2, $3, true)`,
      [row.title, row.description, row.points],
    );
  }
}
