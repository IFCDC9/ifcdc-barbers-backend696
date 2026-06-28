/**
 * V2 social proof & portfolio — reviews, gallery, follows, badges, discovery.
 */
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";
import {
  BARBER_BADGE_DEFINITIONS,
  FOLLOWUP_REMINDER_DAYS,
  HAIRCUT_CATEGORY_IDS,
  MAX_REVIEW_PHOTOS,
  REVIEW_EDIT_WINDOW_HOURS,
} from "./socialPortfolioConstants.js";

const require = createRequire(import.meta.url);
const { bookableBarberWhereSql } = require("./barberBookingPolicy.cjs");

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function mapReviewRow(row, photos = []) {
  return {
    id: String(row.id),
    bookingId: row.booking_id ? String(row.booking_id) : null,
    barberId: String(row.barber_id),
    rating: Number(row.rating),
    comment: row.comment || "",
    customerName: row.customer_name || "Verified customer",
    verifiedClient: true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    photos,
  };
}

function mapPhotoRow(row, { likedByViewer = false } = {}) {
  return {
    id: String(row.id),
    reviewId: row.review_id ? String(row.review_id) : null,
    barberId: String(row.barber_id),
    photoUrl: row.photo_url,
    thumbnailUrl: row.thumbnail_url || row.photo_url,
    caption: row.caption || "",
    photoType: row.photo_type || "after",
    styleCategory: row.style_category || null,
    is30DayFollowup: Boolean(row.is_30_day_followup),
    parentPhotoId: row.parent_photo_id ? String(row.parent_photo_id) : null,
    likeCount: Number(row.like_count) || 0,
    likedByViewer,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function loadPhotosForReviews(reviewIds, viewerUserId = null) {
  if (!reviewIds.length) return new Map();
  const r = await dbQuery(
    `SELECT rp.*,
            EXISTS (
              SELECT 1 FROM photo_likes pl
              WHERE pl.photo_id = rp.id AND pl.user_id = $2::uuid
            ) AS liked_by_viewer
     FROM review_photos rp
     WHERE rp.review_id = ANY($1::uuid[])
       AND rp.status = 'published'
     ORDER BY rp.created_at ASC`,
    [reviewIds, viewerUserId || null],
  );
  const map = new Map();
  for (const row of r.rows || []) {
    const key = String(row.review_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mapPhotoRow(row, { likedByViewer: Boolean(row.liked_by_viewer) }));
  }
  return map;
}

export async function resolveBarberForPortfolio(slugOrId) {
  const raw = String(slugOrId || "").trim();
  if (!raw) return null;

  const bySlug = await dbQuery(
    `SELECT b.*, biz.name AS business_name, biz.city AS business_city, biz.state AS business_state,
            biz.phone AS business_phone, biz.address AS business_address
     FROM barbers b
     LEFT JOIN businesses biz ON biz.id::text = b.business_id::text
     WHERE lower(b.public_slug) = lower($1)
     LIMIT 1`,
    [raw],
  );
  if (bySlug.rows?.[0]) return bySlug.rows[0];

  const byId = await dbQuery(
    `SELECT b.*, biz.name AS business_name, biz.city AS business_city, biz.state AS business_state,
            biz.phone AS business_phone, biz.address AS business_address
     FROM barbers b
     LEFT JOIN businesses biz ON biz.id::text = b.business_id::text
     WHERE b.id::text = $1::text
     LIMIT 1`,
    [raw],
  );
  return byId.rows?.[0] || null;
}

export async function ensureBarberPublicSlug(barberId) {
  const row = await dbQuery(`SELECT id, name, public_slug FROM barbers WHERE id::text = $1::text LIMIT 1`, [
    String(barberId),
  ]);
  const barber = row.rows?.[0];
  if (!barber) return null;
  if (barber.public_slug) return String(barber.public_slug);

  const base = slugify(barber.name) || "barber";
  let candidate = base;
  let n = 0;
  while (n < 20) {
    const exists = await dbQuery(
      `SELECT 1 FROM barbers WHERE lower(public_slug) = lower($1) AND id::text <> $2::text LIMIT 1`,
      [candidate, String(barber.id)],
    );
    if (!exists.rows?.length) break;
    n += 1;
    candidate = `${base}-${String(barber.id).slice(-6)}${n > 1 ? `-${n}` : ""}`;
  }
  await dbQuery(`UPDATE barbers SET public_slug = $2 WHERE id::text = $1::text`, [String(barber.id), candidate]);
  return candidate;
}

async function loadBarberServices(barberId) {
  const r = await dbQuery(
    `SELECT id, name, description, price::float8 AS price, duration_minutes, icon, image_url
     FROM barber_services
     WHERE barber_id::text = $1::text AND COALESCE(is_active, true) = true
     ORDER BY name ASC`,
    [String(barberId)],
  );
  return (r.rows || []).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || "",
    price: row.price != null ? Number(row.price) : null,
    durationMinutes: row.duration_minutes != null ? Number(row.duration_minutes) : null,
    icon: row.icon || "",
    imageUrl: row.image_url || "",
  }));
}

async function loadReviewStats(barberId) {
  const r = await dbQuery(
    `SELECT COUNT(*)::int AS review_count,
            COALESCE(ROUND(AVG(rating)::numeric, 2), 0)::float8 AS average_rating,
            COUNT(*) FILTER (WHERE rating = 5)::int AS five_star_count
     FROM barber_reviews
     WHERE barber_id = $1::text AND status = 'published'`,
    [String(barberId)],
  );
  const row = r.rows?.[0] || {};
  return {
    reviewCount: Number(row.review_count) || 0,
    averageRating: Number(row.average_rating) || 0,
    fiveStarCount: Number(row.five_star_count) || 0,
  };
}

async function loadBarberBadges(barberId) {
  const stats = await loadReviewStats(barberId);
  const likes = await dbQuery(
    `SELECT COALESCE(SUM(like_count), 0)::int AS total_likes FROM review_photos WHERE barber_id = $1::text AND status = 'published'`,
    [String(barberId)],
  );
  const totalLikes = Number(likes.rows?.[0]?.total_likes) || 0;

  const barber = await dbQuery(
    `SELECT years_experience FROM barbers WHERE id::text = $1::text LIMIT 1`,
    [String(barberId)],
  );
  const years = Number(barber.rows?.[0]?.years_experience) || 0;

  const completed = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM bookings WHERE barber_id::text = $1::text AND lower(booking_status) = 'completed'`,
    [String(barberId)],
  );
  const completedCount = Number(completed.rows?.[0]?.n) || 0;

  const recentEngagement = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM review_photos
     WHERE barber_id = $1::text AND status = 'published' AND created_at >= NOW() - INTERVAL '30 days'`,
    [String(barberId)],
  );
  const recentPhotos = Number(recentEngagement.rows?.[0]?.n) || 0;

  const earned = [];
  if (stats.averageRating >= 4.8 && stats.reviewCount >= 10) earned.push("top_rated");
  if (recentPhotos >= 5 || (stats.reviewCount >= 3 && stats.averageRating >= 4.5)) earned.push("trending");
  if (years >= 5 && completedCount >= 50) earned.push("master");
  if (stats.fiveStarCount >= 100) earned.push("hundred_five_star");
  if (totalLikes >= 500) earned.push("most_liked");

  for (const key of earned) {
    await dbQuery(
      `INSERT INTO barber_badges (barber_id, badge_key) VALUES ($1, $2)
       ON CONFLICT (barber_id, badge_key) DO NOTHING`,
      [String(barberId), key],
    ).catch(() => {});
  }

  return earned.map((key) => ({
    key,
    label: BARBER_BADGE_DEFINITIONS[key]?.label || key,
    description: BARBER_BADGE_DEFINITIONS[key]?.description || "",
  }));
}

export async function getPublicBarberPortfolio(slugOrId, { viewerUserId = null } = {}) {
  const barber = await resolveBarberForPortfolio(slugOrId);
  if (!barber) return { ok: false, message: "Barber not found" };

  const barberId = String(barber.id);
  const publicSlug = barber.public_slug || (await ensureBarberPublicSlug(barberId));
  const stats = await loadReviewStats(barberId);
  const services = await loadBarberServices(barberId);
  const badges = await loadBarberBadges(barberId);

  const bookable = await dbQuery(
    `SELECT 1 FROM barbers b WHERE b.id::text = $1::text AND ${bookableBarberWhereSql({ channel: "website" })} LIMIT 1`,
    [barberId],
  );

  const reviewsR = await dbQuery(
    `SELECT r.*, COALESCE(u.name, b.customer_name, 'Verified customer') AS customer_name
     FROM barber_reviews r
     LEFT JOIN app_users u ON u.id = r.customer_user_id
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.barber_id = $1::text AND r.status = 'published'
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [barberId],
  );
  const reviewIds = (reviewsR.rows || []).map((r) => r.id);
  const photoMap = await loadPhotosForReviews(reviewIds, viewerUserId);
  const reviews = (reviewsR.rows || []).map((row) =>
    mapReviewRow(row, photoMap.get(String(row.id)) || []),
  );

  const galleryR = await dbQuery(
    `SELECT rp.*,
            EXISTS (
              SELECT 1 FROM photo_likes pl
              WHERE pl.photo_id = rp.id AND pl.user_id = $2::uuid
            ) AS liked_by_viewer
     FROM review_photos rp
     WHERE rp.barber_id = $1::text AND rp.status = 'published'
     ORDER BY rp.created_at DESC
     LIMIT 60`,
    [barberId, viewerUserId || null],
  );
  const gallery = (galleryR.rows || []).map((row) =>
    mapPhotoRow(row, { likedByViewer: Boolean(row.liked_by_viewer) }),
  );

  let followerCount = 0;
  let isFollowing = false;
  const followStats = await dbQuery(
    `SELECT COUNT(*)::int AS follower_count FROM barber_follows WHERE barber_id = $1::text`,
    [barberId],
  );
  followerCount = Number(followStats.rows?.[0]?.follower_count) || 0;
  if (viewerUserId) {
    const f = await dbQuery(
      `SELECT 1 FROM barber_follows WHERE barber_id = $1::text AND follower_user_id = $2::uuid LIMIT 1`,
      [barberId, viewerUserId],
    );
    isFollowing = Boolean(f.rows?.length);
  }

  const locationParts = [barber.business_city, barber.business_state].filter(Boolean);

  return {
    ok: true,
    portfolio: {
      id: barberId,
      slug: publicSlug,
      name: barber.name || "Barber",
      headline: barber.portfolio_headline || barber.bio || "",
      bio: barber.bio || "",
      profileImage: barber.profile_image || "",
      yearsExperience: barber.years_experience != null ? Number(barber.years_experience) : null,
      averageRating: stats.averageRating,
      reviewCount: stats.reviewCount,
      followerCount,
      isFollowing,
      badges,
      shop: {
        name: barber.shop_name || barber.business_name || "",
        address: barber.business_address || barber.location || "",
        city: barber.business_city || "",
        state: barber.business_state || "",
        phone: barber.business_phone || barber.phone || "",
        locationLabel: locationParts.join(", ") || barber.location || "",
      },
      services,
      reviews,
      gallery,
      bookable: Boolean(bookable.rows?.length),
      publicUrl: `/p/${publicSlug}`,
    },
  };
}

export async function listDiscoverPhotos({ styleCategory = null, limit = 24, viewerUserId = null } = {}) {
  const params = [];
  const where = [`rp.status = 'published'`, `lower(coalesce(b.verification_status, 'approved')) = 'approved'`];
  if (styleCategory) {
    if (!HAIRCUT_CATEGORY_IDS.has(styleCategory)) {
      return { ok: false, message: "Invalid style category." };
    }
    params.push(styleCategory);
    where.push(`rp.style_category = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 24, 1), 100));
  const r = await dbQuery(
    `SELECT rp.*, b.name AS barber_name, b.public_slug AS barber_slug,
            EXISTS (
              SELECT 1 FROM photo_likes pl
              WHERE pl.photo_id = rp.id AND pl.user_id = $${params.length + 1}::uuid
            ) AS liked_by_viewer
     FROM review_photos rp
     JOIN barbers b ON b.id::text = rp.barber_id
     WHERE ${where.join(" AND ")}
     ORDER BY rp.created_at DESC
     LIMIT $${params.length}`,
    [...params, viewerUserId || null],
  );
  return {
    ok: true,
    photos: (r.rows || []).map((row) => ({
      ...mapPhotoRow(row, { likedByViewer: Boolean(row.liked_by_viewer) }),
      barberName: row.barber_name,
      barberSlug: row.barber_slug,
    })),
  };
}

export async function assertBookingEligibleForReview(userId, bookingId) {
  const r = await dbQuery(
    `SELECT b.id, b.barber_id, b.user_id, b.customer_email, b.booking_status
     FROM bookings b WHERE b.id = $1::uuid LIMIT 1`,
    [String(bookingId)],
  );
  const booking = r.rows?.[0];
  if (!booking) return { ok: false, message: "Booking not found." };
  if (String(booking.booking_status || "").toLowerCase() !== "completed") {
    return { ok: false, message: "Only completed appointments can be reviewed." };
  }

  const uid = String(userId || "");
  const ownsBooking =
    (booking.user_id && String(booking.user_id) === uid) ||
    (await dbQuery(`SELECT 1 FROM app_users WHERE id = $1::uuid AND lower(email) = lower($2) LIMIT 1`, [
      uid,
      booking.customer_email,
    ]).then((x) => Boolean(x.rows?.length)));

  if (!ownsBooking) return { ok: false, message: "You can only review your own completed bookings." };

  const existing = await dbQuery(`SELECT id FROM barber_reviews WHERE booking_id = $1::uuid LIMIT 1`, [
    String(bookingId),
  ]);
  if (existing.rows?.length) return { ok: false, message: "This appointment already has a review." };

  return { ok: true, booking };
}

function reviewEditDeadline(createdAt) {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  d.setHours(d.getHours() + REVIEW_EDIT_WINDOW_HOURS);
  return d;
}

function isWithinReviewEditWindow(createdAt) {
  const deadline = reviewEditDeadline(createdAt);
  return Boolean(deadline && deadline > new Date());
}

async function assertCustomerOwnsReview(userId, reviewId) {
  const r = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = r.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };
  if (!review.customer_user_id || String(review.customer_user_id) !== String(userId)) {
    return { ok: false, message: "Not authorized." };
  }
  if (!isWithinReviewEditWindow(review.created_at)) {
    return {
      ok: false,
      message: `Reviews can only be edited or deleted within ${REVIEW_EDIT_WINDOW_HOURS} hours of submission.`,
    };
  }
  return { ok: true, review };
}

export async function updateCustomerReview({ userId, reviewId, rating, comment }) {
  const owned = await assertCustomerOwnsReview(userId, reviewId);
  if (!owned.ok) return owned;

  const normalizedRating = Number(rating);
  if (!Number.isFinite(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    return { ok: false, message: "Rating must be between 1 and 5." };
  }

  const upd = await dbQuery(
    `UPDATE barber_reviews
     SET rating = $2, comment = $3, updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING *`,
    [String(reviewId), normalizedRating, String(comment || "").trim() || null],
  );
  const review = upd.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };

  const photos = await loadPhotosForReviews([review.id], userId);
  return {
    ok: true,
    review: mapReviewRow(review, photos.get(String(review.id)) || []),
    editWindowEndsAt: reviewEditDeadline(review.created_at)?.toISOString() || null,
  };
}

export async function deleteCustomerReview(userId, reviewId) {
  const owned = await assertCustomerOwnsReview(userId, reviewId);
  if (!owned.ok) return owned;

  await dbQuery(`DELETE FROM barber_reviews WHERE id = $1::uuid`, [String(reviewId)]);
  return { ok: true, message: "Review deleted." };
}

export async function createBarberReview({
  userId,
  bookingId,
  rating,
  comment = "",
  photos = [],
}) {
  const eligible = await assertBookingEligibleForReview(userId, bookingId);
  if (!eligible.ok) return eligible;

  const normalizedRating = Number(rating);
  if (!Number.isFinite(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    return { ok: false, message: "Rating must be between 1 and 5." };
  }

  const photoList = Array.isArray(photos) ? photos.slice(0, MAX_REVIEW_PHOTOS) : [];
  const booking = eligible.booking;
  const barberId = String(booking.barber_id);

  const ins = await dbQuery(
    `INSERT INTO barber_reviews (booking_id, barber_id, customer_user_id, rating, comment, status)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'published')
     RETURNING *`,
    [String(bookingId), barberId, userId, normalizedRating, String(comment || "").trim() || null],
  );
  const review = ins.rows?.[0];
  const savedPhotos = [];

  for (const p of photoList) {
    const styleCategory = p.styleCategory && HAIRCUT_CATEGORY_IDS.has(p.styleCategory) ? p.styleCategory : null;
    const pr = await dbQuery(
      `INSERT INTO review_photos (
         review_id, barber_id, photo_url, thumbnail_url, caption, photo_type, style_category, status
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'published')
       RETURNING *`,
      [
        review.id,
        barberId,
        p.photoUrl,
        p.thumbnailUrl || p.photoUrl,
        p.caption || null,
        ["before", "after", "standard"].includes(p.photoType) ? p.photoType : "after",
        styleCategory,
      ],
    );
    if (pr.rows?.[0]) savedPhotos.push(mapPhotoRow(pr.rows[0]));
  }

  await notifyBarberFollowersNewPhotos(barberId, savedPhotos.length).catch(() => {});

  return {
    ok: true,
    review: mapReviewRow(review, savedPhotos),
  };
}

export async function addReviewPhotos({ userId, reviewId, photos = [] }) {
  const r = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = r.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };
  if (review.customer_user_id && String(review.customer_user_id) !== String(userId)) {
    return { ok: false, message: "Not authorized." };
  }

  const existing = await dbQuery(`SELECT COUNT(*)::int AS n FROM review_photos WHERE review_id = $1::uuid`, [
    String(reviewId),
  ]);
  const current = Number(existing.rows?.[0]?.n) || 0;
  const photoList = Array.isArray(photos) ? photos : [];
  if (current + photoList.length > MAX_REVIEW_PHOTOS) {
    return { ok: false, message: `Maximum ${MAX_REVIEW_PHOTOS} photos per review.` };
  }

  const saved = [];
  for (const p of photoList) {
    const pr = await dbQuery(
      `INSERT INTO review_photos (
         review_id, barber_id, photo_url, thumbnail_url, caption, photo_type, style_category,
         is_30_day_followup, parent_photo_id, status
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, 'published')
       RETURNING *`,
      [
        review.id,
        String(review.barber_id),
        p.photoUrl,
        p.thumbnailUrl || p.photoUrl,
        p.caption || null,
        ["before", "after", "standard"].includes(p.photoType) ? p.photoType : "after",
        p.styleCategory && HAIRCUT_CATEGORY_IDS.has(p.styleCategory) ? p.styleCategory : null,
        Boolean(p.is30DayFollowup),
        p.parentPhotoId || null,
      ],
    );
    if (pr.rows?.[0]) saved.push(mapPhotoRow(pr.rows[0]));
  }

  if (saved.some((p) => p.is30DayFollowup)) {
    await dbQuery(
      `UPDATE haircut_followup_reminders SET status = 'completed', completed_at = NOW()
       WHERE booking_id = $1::uuid`,
      [String(review.booking_id)],
    ).catch(() => {});
  }

  await notifyBarberFollowersNewPhotos(String(review.barber_id), saved.length).catch(() => {});

  return { ok: true, photos: saved };
}

export async function togglePhotoLike(userId, photoId) {
  const photo = await dbQuery(`SELECT id, like_count FROM review_photos WHERE id = $1::uuid LIMIT 1`, [
    String(photoId),
  ]);
  if (!photo.rows?.[0]) return { ok: false, message: "Photo not found." };

  const existing = await dbQuery(
    `SELECT id FROM photo_likes WHERE photo_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
    [String(photoId), userId],
  );
  if (existing.rows?.length) {
    await dbQuery(`DELETE FROM photo_likes WHERE photo_id = $1::uuid AND user_id = $2::uuid`, [
      String(photoId),
      userId,
    ]);
    await dbQuery(`UPDATE review_photos SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1::uuid`, [
      String(photoId),
    ]);
    return { ok: true, liked: false };
  }

  await dbQuery(`INSERT INTO photo_likes (photo_id, user_id) VALUES ($1::uuid, $2::uuid)`, [String(photoId), userId]);
  await dbQuery(`UPDATE review_photos SET like_count = like_count + 1 WHERE id = $1::uuid`, [String(photoId)]);
  return { ok: true, liked: true };
}

export async function followBarber(userId, barberId) {
  const exists = await dbQuery(`SELECT 1 FROM barbers WHERE id::text = $1::text LIMIT 1`, [String(barberId)]);
  if (!exists.rows?.length) return { ok: false, message: "Barber not found." };
  await dbQuery(
    `INSERT INTO barber_follows (barber_id, follower_user_id) VALUES ($1, $2::uuid)
     ON CONFLICT (barber_id, follower_user_id) DO NOTHING`,
    [String(barberId), userId],
  );
  return { ok: true, following: true };
}

export async function unfollowBarber(userId, barberId) {
  await dbQuery(`DELETE FROM barber_follows WHERE barber_id = $1 AND follower_user_id = $2::uuid`, [
    String(barberId),
    userId,
  ]);
  return { ok: true, following: false };
}

export async function reportContent({ userId, targetType, targetId, reason, details = "" }) {
  const t = String(targetType || "").toLowerCase();
  if (!["review", "photo"].includes(t)) return { ok: false, message: "Invalid report target." };
  await dbQuery(
    `INSERT INTO content_reports (reporter_user_id, target_type, target_id, reason, details, status)
     VALUES ($1::uuid, $2, $3, $4, $5, 'pending')`,
    [userId || null, t, String(targetId), String(reason || "other"), String(details || "").trim() || null],
  );
  if (t === "review") {
    await dbQuery(`UPDATE barber_reviews SET status = 'reported' WHERE id = $1::uuid`, [String(targetId)]).catch(
      () => {},
    );
  } else {
    await dbQuery(`UPDATE review_photos SET status = 'reported' WHERE id = $1::uuid`, [String(targetId)]).catch(
      () => {},
    );
  }
  return { ok: true, message: "Report submitted. Our team will review it." };
}

export async function scheduleHaircutFollowupReminder(bookingRow) {
  if (!bookingRow?.id) return;
  if (String(bookingRow.booking_status || "").toLowerCase() !== "completed") return;

  const remindAt = new Date();
  remindAt.setDate(remindAt.getDate() + FOLLOWUP_REMINDER_DAYS);

  await dbQuery(
    `INSERT INTO haircut_followup_reminders (
       booking_id, barber_id, customer_user_id, customer_email, remind_at, status
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'scheduled')
     ON CONFLICT (booking_id) DO NOTHING`,
    [
      String(bookingRow.id),
      String(bookingRow.barber_id),
      bookingRow.user_id || null,
      bookingRow.customer_email || null,
      remindAt.toISOString(),
    ],
  );
}

async function notifyBarberFollowersNewPhotos(barberId, photoCount) {
  if (!photoCount) return;
  const pushNotifier = require("./pushNotifier.cjs");
  const followers = await dbQuery(`SELECT follower_user_id FROM barber_follows WHERE barber_id = $1`, [
    String(barberId),
  ]);
  const barber = await dbQuery(`SELECT name FROM barbers WHERE id::text = $1::text LIMIT 1`, [String(barberId)]);
  const name = barber.rows?.[0]?.name || "A barber you follow";
  const userIds = (followers.rows || []).map((r) => String(r.follower_user_id)).filter(Boolean);
  if (!userIds.length) return;
  await pushNotifier.sendPushToUsers({
    dbQuery,
    userIds,
    kind: "marketing",
    title: "New haircut photos",
    body: `${name} uploaded ${photoCount} new photo${photoCount === 1 ? "" : "s"}.`,
    data: { barberId: String(barberId), type: "barber_new_photos" },
  });
}

export async function listPendingContentReports() {
  const r = await dbQuery(
    `SELECT * FROM content_reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT 200`,
  );
  return (r.rows || []).map((row) => ({
    id: String(row.id),
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    details: row.details || "",
    reporterUserId: row.reporter_user_id ? String(row.reporter_user_id) : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

export async function resolveContentReport(reportId, { status, adminNotes, adminUserId } = {}) {
  const normalized = String(status || "").toLowerCase();
  if (!["reviewed", "action_taken", "dismissed"].includes(normalized)) {
    return { ok: false, message: "Invalid status." };
  }
  const existing = await dbQuery(`SELECT * FROM content_reports WHERE id = $1::uuid LIMIT 1`, [String(reportId)]);
  const report = existing.rows?.[0];
  if (!report) return { ok: false, message: "Report not found." };

  await dbQuery(
    `UPDATE content_reports SET status = $2, admin_notes = $3, reviewed_by = $4::uuid, reviewed_at = NOW()
     WHERE id = $1::uuid`,
    [String(reportId), normalized, adminNotes || null, adminUserId || null],
  );

  if (normalized === "dismissed") {
    const targetType = String(report.target_type || "").toLowerCase();
    if (targetType === "review") {
      await dbQuery(
        `UPDATE barber_reviews SET status = 'published', updated_at = NOW()
         WHERE id = $1::uuid AND status = 'reported'`,
        [String(report.target_id)],
      ).catch(() => {});
    } else if (targetType === "photo") {
      await dbQuery(
        `UPDATE review_photos SET status = 'published'
         WHERE id = $1::uuid AND status = 'reported'`,
        [String(report.target_id)],
      ).catch(() => {});
    }
  }

  return { ok: true };
}

export async function setReviewVisibility(reviewId, status) {
  const s = String(status || "").toLowerCase();
  if (!["published", "hidden"].includes(s)) return { ok: false, message: "Invalid status." };
  await dbQuery(`UPDATE barber_reviews SET status = $2, updated_at = NOW() WHERE id = $1::uuid`, [
    String(reviewId),
    s,
  ]);
  return { ok: true };
}

export async function setPhotoVisibility(photoId, status) {
  const s = String(status || "").toLowerCase();
  if (!["published", "hidden"].includes(s)) return { ok: false, message: "Invalid status." };
  await dbQuery(`UPDATE review_photos SET status = $2 WHERE id = $1::uuid`, [String(photoId), s]);
  return { ok: true };
}

export async function listReviewableBookings(userId) {
  const r = await dbQuery(
    `SELECT b.id, b.barber_id, b.barber_name, b.service, b.date, b.time, b.booking_status
     FROM bookings b
     LEFT JOIN barber_reviews r ON r.booking_id = b.id
     WHERE lower(b.booking_status) = 'completed'
       AND r.id IS NULL
       AND (
         b.user_id = $1::uuid
         OR lower(b.customer_email) = (SELECT lower(email) FROM app_users WHERE id = $1::uuid LIMIT 1)
       )
     ORDER BY b.date DESC, b.time DESC
     LIMIT 50`,
    [String(userId)],
  );
  return (r.rows || []).map((row) => ({
    id: String(row.id),
    barberId: String(row.barber_id),
    barberName: row.barber_name || "",
    service: row.service || "",
    date: row.date,
    time: row.time,
  }));
}

export async function listPendingFollowupReminders(limit = 50) {
  const r = await dbQuery(
    `SELECT * FROM haircut_followup_reminders
     WHERE status = 'scheduled' AND remind_at <= NOW()
     ORDER BY remind_at ASC
     LIMIT $1`,
    [Math.min(Number(limit) || 50, 200)],
  );
  return r.rows || [];
}

export async function markFollowupReminderSent(reminderId) {
  await dbQuery(
    `UPDATE haircut_followup_reminders SET status = 'sent', reminded_at = NOW() WHERE id = $1::uuid`,
    [String(reminderId)],
  );
}

export async function getBookingReviewStatus(userId, bookingId) {
  const eligible = await assertBookingEligibleForReview(userId, bookingId);
  if (eligible.ok) {
    return { ok: true, canReview: true, hasReview: false, reviewId: null, canEdit: false, canDelete: false };
  }
  if (eligible.message === "This appointment already has a review.") {
    const existing = await dbQuery(
      `SELECT id, rating, comment, created_at FROM barber_reviews WHERE booking_id = $1::uuid LIMIT 1`,
      [String(bookingId)],
    );
    const row = existing.rows?.[0];
    const reviewId = row?.id ? String(row.id) : null;
    const editable = row ? isWithinReviewEditWindow(row.created_at) : false;
    return {
      ok: true,
      canReview: false,
      hasReview: true,
      reviewId,
      canEdit: editable,
      canDelete: editable,
      editWindowEndsAt: row ? reviewEditDeadline(row.created_at)?.toISOString() || null : null,
      rating: row ? Number(row.rating) : null,
      comment: row?.comment || "",
    };
  }
  return {
    ok: true,
    canReview: false,
    hasReview: false,
    reviewId: null,
    canEdit: false,
    canDelete: false,
    reason: eligible.message,
  };
}

export async function listCustomerFollowupReminders(userId) {
  const r = await dbQuery(
    `SELECT h.*, b.barber_name, b.service, b.date,
            r.id AS review_id
     FROM haircut_followup_reminders h
     LEFT JOIN bookings b ON b.id = h.booking_id
     LEFT JOIN barber_reviews r ON r.booking_id = h.booking_id
     WHERE h.status IN ('scheduled', 'sent')
       AND h.completed_at IS NULL
       AND (
         h.customer_user_id = $1::uuid
         OR lower(h.customer_email) = (SELECT lower(email) FROM app_users WHERE id = $1::uuid LIMIT 1)
       )
     ORDER BY h.remind_at ASC
     LIMIT 20`,
    [String(userId)],
  );
  return (r.rows || []).map((row) => ({
    id: String(row.id),
    bookingId: String(row.booking_id),
    barberId: String(row.barber_id),
    barberName: row.barber_name || "",
    service: row.service || "",
    appointmentDate: row.date ? String(row.date).slice(0, 10) : null,
    reviewId: row.review_id ? String(row.review_id) : null,
    remindAt: row.remind_at ? new Date(row.remind_at).toISOString() : null,
    status: row.status,
    due: row.remind_at ? new Date(row.remind_at) <= new Date() : false,
  }));
}

export async function sendDueFollowupReminders() {
  const pushNotifier = require("./pushNotifier.cjs");
  const due = await dbQuery(
    `SELECT h.*, b.barber_name
     FROM haircut_followup_reminders h
     LEFT JOIN bookings b ON b.id = h.booking_id
     WHERE h.status = 'scheduled' AND h.remind_at <= NOW()
     ORDER BY h.remind_at ASC
     LIMIT 100`,
  );
  let sent = 0;
  for (const row of due.rows || []) {
    const userId = row.customer_user_id ? String(row.customer_user_id) : null;
    if (userId) {
      await pushNotifier.sendPushToUsers({
        dbQuery,
        userIds: [userId],
        kind: "booking_reminder",
        title: "How's your haircut looking?",
        body: `Share a 30-day update photo for your visit with ${row.barber_name || "your barber"}.`,
        data: {
          type: "haircut_followup",
          bookingId: String(row.booking_id),
          barberId: String(row.barber_id),
        },
      }).catch(() => {});
    }
    await markFollowupReminderSent(row.id);
    sent += 1;
  }
  return { ok: true, sent };
}
