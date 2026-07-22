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
  normalizeDiscoverCategory,
  matchesDiscoverCategoryFilter,
  bustImageCacheUrl,
} from "./socialPortfolioConstants.js";

const require = createRequire(import.meta.url);
const { bookableBarberWhereSql } = require("./barberBookingPolicy.cjs");
const {
  loadGalleryPhotoIndexForBarber,
  enrichServicesWithGalleryPhotos,
} = require("./servicePhotoResolver.cjs");
const { resolvePublishedImageUrl } = require("./styleImageUrl.cjs");

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
    status: row.status || "published",
    barberReply: row.barber_reply || "",
    barberReplyAt: row.barber_reply_at ? new Date(row.barber_reply_at).toISOString() : null,
    photos,
  };
}

async function assertUserCanReplyAsBarber(userId, barberId) {
  const uid = String(userId || "").trim();
  const bid = String(barberId || "").trim();
  if (!uid || !bid) return { ok: false, message: "Not authorized." };
  const r = await dbQuery(
    `SELECT 1
     FROM app_users u
     WHERE u.id = $1::uuid
       AND (
         lower(coalesce(u.role, '')) IN ('super_admin', 'admin')
         OR u.barber_id::text = $2::text
         OR EXISTS (
           SELECT 1 FROM barbers b
           WHERE b.id::text = $2::text AND b.user_id = u.id
         )
       )
     LIMIT 1`,
    [uid, bid],
  );
  if (!r.rows?.[0]) return { ok: false, message: "Only this provider can reply to reviews." };
  return { ok: true };
}

function mapPhotoRow(row, { likedByViewer = false } = {}) {
  const barberId = String(row.barber_id || "");
  const photoUrl =
    resolvePublishedImageUrl(row.photo_url, { barberId, styleId: row.id }) || String(row.photo_url || "");
  const thumbnailUrl =
    resolvePublishedImageUrl(row.thumbnail_url || row.photo_url, { barberId, styleId: row.id }) || photoUrl;
  return {
    id: String(row.id),
    reviewId: row.review_id ? String(row.review_id) : null,
    barberId,
    photoUrl,
    thumbnailUrl,
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

async function loadStyleGalleryLikeMap(galleryIds, viewerUserId) {
  const ids = [...new Set((galleryIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return new Map();

  const params = [ids];
  let likedSql = "false AS liked_by_viewer";
  if (viewerUserId) {
    params.push(viewerUserId);
    likedSql = `EXISTS (
      SELECT 1 FROM style_gallery_likes sgl
      WHERE sgl.gallery_id = g.id AND sgl.user_id = $2::uuid
    ) AS liked_by_viewer`;
  }

  const r = await dbQuery(
    `SELECT g.id::text AS id, COALESCE(g.like_count, 0)::int AS like_count, ${likedSql}
     FROM barber_style_gallery g
     WHERE g.id::text = ANY($1::text[])`,
    params,
  );

  const map = new Map();
  for (const row of r.rows || []) {
    map.set(String(row.id), {
      likeCount: Number(row.like_count) || 0,
      likedByViewer: Boolean(row.liked_by_viewer),
    });
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
    `SELECT id, barber_id, name, description, price::float8 AS price, duration_minutes, icon, image_url
     FROM barber_services
     WHERE barber_id::text = $1::text AND COALESCE(is_active, true) = true
     ORDER BY name ASC`,
    [String(barberId)],
  );
  const rows = r.rows || [];
  const galleryIndex = await loadGalleryPhotoIndexForBarber(dbQuery, String(barberId));
  const enriched = enrichServicesWithGalleryPhotos(rows, galleryIndex);
  return enriched.map((row) => {
    const imageUrl =
      resolvePublishedImageUrl(row.cover_image_url || row.image_url, {
        serviceId: row.id,
        barberId: row.barber_id || barberId,
      }) || "";
    return {
      id: row.id,
      name: row.name,
      description: row.description || "",
      price: row.price != null ? Number(row.price) : null,
      durationMinutes: row.duration_minutes != null ? Number(row.duration_minutes) : null,
      icon: row.icon || "",
      imageUrl,
    };
  });
}

async function loadReviewStats(barberId) {
  const r = await dbQuery(
    `SELECT COUNT(*)::int AS review_count,
            COALESCE(ROUND(AVG(rating)::numeric, 2), 0)::float8 AS average_rating,
            COUNT(*) FILTER (WHERE rating = 5)::int AS five_star_count,
            COUNT(*) FILTER (WHERE rating = 4)::int AS four_star_count,
            COUNT(*) FILTER (WHERE rating = 3)::int AS three_star_count,
            COUNT(*) FILTER (WHERE rating = 2)::int AS two_star_count,
            COUNT(*) FILTER (WHERE rating = 1)::int AS one_star_count,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM review_photos rp
              WHERE rp.review_id = barber_reviews.id AND rp.status = 'published'
            ))::int AS with_photos_count
     FROM barber_reviews
     WHERE barber_id = $1::text AND status = 'published' AND deleted_at IS NULL`,
    [String(barberId)],
  );
  const row = r.rows?.[0] || {};
  return {
    reviewCount: Number(row.review_count) || 0,
    averageRating: Number(row.average_rating) || 0,
    fiveStarCount: Number(row.five_star_count) || 0,
    ratingBreakdown: {
      5: Number(row.five_star_count) || 0,
      4: Number(row.four_star_count) || 0,
      3: Number(row.three_star_count) || 0,
      2: Number(row.two_star_count) || 0,
      1: Number(row.one_star_count) || 0,
    },
    withPhotosCount: Number(row.with_photos_count) || 0,
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

export async function getPublicBarberPortfolio(slugOrId, { viewerUserId = null, reviewSort = "newest", reviewLimit = 20, reviewOffset = 0 } = {}) {
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

  const sort = String(reviewSort || "newest").toLowerCase();
  let orderSql = "r.created_at DESC";
  if (sort === "highest") orderSql = "r.rating DESC, r.created_at DESC";
  else if (sort === "lowest") orderSql = "r.rating ASC, r.created_at DESC";
  else if (sort === "photos") {
    orderSql = `(SELECT COUNT(*) FROM review_photos rp WHERE rp.review_id = r.id AND rp.status = 'published') DESC, r.created_at DESC`;
  }
  const limit = Math.min(50, Math.max(1, Number(reviewLimit) || 20));
  const offset = Math.max(0, Number(reviewOffset) || 0);

  const reviewsR = await dbQuery(
    `SELECT r.*, COALESCE(u.name, b.customer_name, 'Verified customer') AS customer_name
     FROM barber_reviews r
     LEFT JOIN app_users u ON u.id = r.customer_user_id
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.barber_id = $1::text AND r.status = 'published' AND r.deleted_at IS NULL
     ORDER BY ${orderSql}
     LIMIT $2 OFFSET $3`,
    [barberId, limit, offset],
  );
  const reviewIds = (reviewsR.rows || []).map((r) => r.id);
  const photoMap = await loadPhotosForReviews(reviewIds, viewerUserId);
  const reviews = (reviewsR.rows || []).map((row) =>
    mapReviewRow(row, photoMap.get(String(row.id)) || []),
  );

  const styleGalleryR = await dbQuery(
    `SELECT id, barber_id, service_id, image_url, title, price, duration_minutes, created_at,
            COALESCE(is_primary, false) AS is_primary
     FROM barber_style_gallery
     WHERE barber_id::text = $1::text AND COALESCE(is_published, true) = true
     ORDER BY sort_order ASC, created_at DESC
     LIMIT 60`,
    [barberId],
  ).catch(() => ({ rows: [] }));

  const serviceIdsWithCover = new Set(
    services.filter((s) => s.imageUrl).map((s) => String(s.id)),
  );

  const serviceToGalleryId = new Map();
  const galleryIds = [];
  for (const row of styleGalleryR.rows || []) {
    galleryIds.push(String(row.id));
    const sid = row.service_id != null ? String(row.service_id) : "";
    if (!sid) continue;
    const prev = serviceToGalleryId.get(sid);
    if (!prev || row.is_primary) serviceToGalleryId.set(sid, String(row.id));
  }
  const likeMap = await loadStyleGalleryLikeMap(galleryIds, viewerUserId);

  /** Portfolio gallery: one tile per service (authoritative cover) + extra gallery rows not already on a service. */
  const gallery = [];
  for (const svc of services) {
    if (!svc.imageUrl) continue;
    const gid = serviceToGalleryId.get(String(svc.id));
    const likeInfo = gid ? likeMap.get(gid) : null;
    gallery.push({
      id: `svc-${String(svc.id)}`,
      reviewId: null,
      barberId,
      serviceId: String(svc.id),
      serviceName: svc.name,
      price: svc.price,
      durationMinutes: svc.durationMinutes,
      photoUrl: svc.imageUrl,
      thumbnailUrl: svc.imageUrl,
      caption: svc.name,
      photoType: "service",
      styleCategory: null,
      is30DayFollowup: false,
      parentPhotoId: null,
      likeCount: likeInfo?.likeCount ?? 0,
      likedByViewer: likeInfo?.likedByViewer ?? false,
      createdAt: null,
    });
  }

  for (const row of styleGalleryR.rows || []) {
    if (!row.image_url) continue;
    const sid = row.service_id != null ? String(row.service_id) : "";
    if (sid && serviceIdsWithCover.has(sid)) continue;
    const url = resolvePublishedImageUrl(row.image_url, {
      barberId,
      styleId: `gal-${row.id}`,
    });
    if (!url) continue;
    const likeInfo = likeMap.get(String(row.id));
    gallery.push({
      id: `gal-${String(row.id)}`,
      reviewId: null,
      barberId,
      serviceId: sid || null,
      serviceName: row.title || "",
      price: row.price != null ? Number(row.price) : null,
      durationMinutes: row.duration_minutes != null ? Number(row.duration_minutes) : null,
      photoUrl: url,
      thumbnailUrl: url,
      caption: row.title || "",
      photoType: "standard",
      styleCategory: null,
      is30DayFollowup: false,
      parentPhotoId: null,
      likeCount: likeInfo?.likeCount ?? 0,
      likedByViewer: likeInfo?.likedByViewer ?? false,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    });
  }

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
      headline: barber.portfolio_headline || "",
      bio: barber.bio || "",
      profileImage: barber.profile_image || "",
      coverImage: barber.logo || "",
      yearsExperience:
        barber.years_experience != null && Number(barber.years_experience) > 0
          ? Number(barber.years_experience)
          : null,
      averageRating: stats.averageRating,
      reviewCount: stats.reviewCount,
      ratingBreakdown: stats.ratingBreakdown,
      withPhotosCount: stats.withPhotosCount,
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
      reviewsMeta: {
        sort,
        limit,
        offset,
        hasMore: reviews.length >= limit,
        total: stats.reviewCount,
      },
      gallery,
      bookable: Boolean(bookable.rows?.length),
      publicUrl: `/p/${publicSlug}`,
    },
  };
}

function rowMatchesDiscoverCategory(styleCategory, fields) {
  return matchesDiscoverCategoryFilter(styleCategory, fields);
}

async function resolveDiscoverEditContext(viewer) {
  if (!viewer?.id && !viewer?.role) return null;
  const role = String(viewer.role || "").toLowerCase();
  const userId = viewer.id ? String(viewer.id) : null;
  let barberId = viewer.barberId || viewer.barber_id || null;
  let businessId = viewer.businessId || viewer.business_id || null;

  if (userId) {
    try {
      const r = await dbQuery(
        `SELECT role, barber_id, business_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [userId],
      );
      const row = r.rows?.[0];
      if (row) {
        if (!role) {
          /* keep */
        }
        barberId = barberId || row.barber_id;
        businessId = businessId ?? row.business_id;
        return {
          userId,
          role: String(row.role || role || "").toLowerCase(),
          barberId: barberId != null ? String(barberId) : null,
          businessId: businessId != null ? String(businessId) : null,
          isPlatformAdmin:
            String(row.role || "").toLowerCase() === "super_admin" ||
            String(row.role || "").toLowerCase() === "admin" ||
            Boolean(viewer.isSuperAdmin),
        };
      }
    } catch {
      /* fall through */
    }
  }

  return {
    userId,
    role,
    barberId: barberId != null ? String(barberId) : null,
    businessId: businessId != null ? String(businessId) : null,
    isPlatformAdmin: role === "super_admin" || role === "admin" || Boolean(viewer.isSuperAdmin),
  };
}

function canEditDiscoverBarber(editContext, barberId, barberBusinessId) {
  if (!editContext) return false;
  if (editContext.isPlatformAdmin) return true;
  const role = String(editContext.role || "").toLowerCase();
  const bid = String(barberId || "");
  if (role === "barber" && editContext.barberId && String(editContext.barberId) === bid) return true;
  if (
    role === "shop_owner" &&
    editContext.businessId &&
    barberBusinessId != null &&
    String(editContext.businessId) === String(barberBusinessId)
  ) {
    return true;
  }
  return false;
}

function parseDiscoverPhotoId(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;
  if (id.startsWith("gal-")) return { source: "gallery", rawId: id.slice(4), discoverId: id };
  if (id.startsWith("svc-")) {
    const rest = id.slice(4);
    const lastDash = rest.lastIndexOf("-");
    if (lastDash > 0) {
      return {
        source: "service",
        serviceId: rest.slice(0, lastDash),
        barberId: rest.slice(lastDash + 1),
        discoverId: id,
      };
    }
  }
  return { source: "review", rawId: id, discoverId: id };
}

export async function assertCanManageDiscoverPhoto(viewer, discoverId) {
  const parsed = parseDiscoverPhotoId(discoverId);
  if (!parsed) return { ok: false, message: "Invalid photo id." };
  const ctx = await resolveDiscoverEditContext(viewer);
  if (!ctx) return { ok: false, message: "Sign in required." };

  let barberId = null;
  let businessId = null;

  if (parsed.source === "gallery") {
    const r = await dbQuery(
      `SELECT g.barber_id, b.business_id
       FROM barber_style_gallery g
       JOIN barbers b ON b.id::text = g.barber_id::text
       WHERE g.id = $1::uuid LIMIT 1`,
      [parsed.rawId],
    );
    if (!r.rows?.[0]) return { ok: false, message: "Photo not found." };
    barberId = String(r.rows[0].barber_id);
    businessId = r.rows[0].business_id;
  } else if (parsed.source === "service") {
    const r = await dbQuery(
      `SELECT s.barber_id, b.business_id
       FROM barber_services s
       JOIN barbers b ON b.id::text = s.barber_id::text
       WHERE s.id::text = $1::text LIMIT 1`,
      [parsed.serviceId],
    );
    if (!r.rows?.[0]) return { ok: false, message: "Photo not found." };
    barberId = String(r.rows[0].barber_id);
    businessId = r.rows[0].business_id;
  } else {
    const r = await dbQuery(
      `SELECT rp.barber_id, b.business_id
       FROM review_photos rp
       JOIN barbers b ON b.id::text = rp.barber_id
       WHERE rp.id = $1::uuid LIMIT 1`,
      [parsed.rawId],
    );
    if (!r.rows?.[0]) return { ok: false, message: "Photo not found." };
    barberId = String(r.rows[0].barber_id);
    businessId = r.rows[0].business_id;
  }

  if (!canEditDiscoverBarber(ctx, barberId, businessId)) {
    return { ok: false, message: "Not authorized to manage this photo." };
  }
  return { ok: true, parsed, barberId, businessId, ctx };
}

export async function updateDiscoverPhotoMetadata(discoverId, patch = {}) {
  const parsed = parseDiscoverPhotoId(discoverId);
  if (!parsed) return { ok: false, message: "Invalid photo id." };
  const title = patch.title != null ? String(patch.title).trim() : null;
  const caption = patch.caption != null ? String(patch.caption).trim() : null;
  const description = patch.description != null ? String(patch.description).trim() : caption;
  const category =
    patch.styleCategory != null || patch.category != null
      ? normalizeDiscoverCategory(patch.styleCategory || patch.category)
      : null;

  if (parsed.source === "gallery") {
    const sets = [];
    const params = [parsed.rawId];
    if (title != null) {
      params.push(title);
      sets.push(`title = $${params.length}`);
    }
    if (description != null) {
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (category != null) {
      params.push(category);
      sets.push(`category = $${params.length}`);
    }
    if (!sets.length) return { ok: true };
    await dbQuery(`UPDATE barber_style_gallery SET ${sets.join(", ")} WHERE id = $1::uuid`, params);
    return { ok: true };
  }

  if (parsed.source === "service") {
    const sets = [];
    const params = [parsed.serviceId];
    if (title != null) {
      params.push(title);
      sets.push(`name = $${params.length}`);
    }
    if (description != null) {
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (category != null) {
      params.push(category);
      sets.push(`category = $${params.length}`);
    }
    if (!sets.length) return { ok: true };
    await dbQuery(`UPDATE barber_services SET ${sets.join(", ")} WHERE id::text = $1::text`, params);
    return { ok: true };
  }

  const sets = [];
  const params = [parsed.rawId];
  if (caption != null || title != null) {
    params.push(caption ?? title);
    sets.push(`caption = $${params.length}`);
  }
  if (category != null) {
    params.push(category);
    sets.push(`style_category = $${params.length}`);
  }
  if (!sets.length) return { ok: true };
  await dbQuery(`UPDATE review_photos SET ${sets.join(", ")} WHERE id = $1::uuid`, params);
  return { ok: true };
}

export async function setDiscoverPhotoVisibility(discoverId, status) {
  const s = String(status || "").toLowerCase();
  if (!["published", "hidden"].includes(s)) return { ok: false, message: "Invalid status." };
  const parsed = parseDiscoverPhotoId(discoverId);
  if (!parsed) return { ok: false, message: "Invalid photo id." };

  if (parsed.source === "gallery") {
    await dbQuery(`UPDATE barber_style_gallery SET is_published = $2 WHERE id = $1::uuid`, [
      parsed.rawId,
      s === "published",
    ]);
    return { ok: true };
  }
  if (parsed.source === "service") {
    await dbQuery(`UPDATE barber_services SET is_active = $2 WHERE id::text = $1::text`, [
      parsed.serviceId,
      s === "published",
    ]);
    return { ok: true };
  }
  await dbQuery(`UPDATE review_photos SET status = $2 WHERE id = $1::uuid`, [parsed.rawId, s]);
  return { ok: true };
}

export async function setDiscoverPhotoCover(discoverId) {
  const parsed = parseDiscoverPhotoId(discoverId);
  if (!parsed) return { ok: false, message: "Invalid photo id." };
  if (parsed.source === "gallery") {
    const row = await dbQuery(`SELECT barber_id, service_id FROM barber_style_gallery WHERE id = $1::uuid`, [
      parsed.rawId,
    ]);
    if (!row.rows?.[0]) return { ok: false, message: "Photo not found." };
    const barberId = row.rows[0].barber_id;
    const serviceId = row.rows[0].service_id;
    if (serviceId != null) {
      await dbQuery(
        `UPDATE barber_style_gallery SET is_primary = false
         WHERE barber_id::text = $1::text AND service_id = $2`,
        [String(barberId), serviceId],
      );
    } else {
      await dbQuery(
        `UPDATE barber_style_gallery SET is_primary = false WHERE barber_id::text = $1::text AND service_id IS NULL`,
        [String(barberId)],
      );
    }
    await dbQuery(`UPDATE barber_style_gallery SET is_primary = true WHERE id = $1::uuid`, [parsed.rawId]);
    if (serviceId != null) {
      const img = await dbQuery(`SELECT image_url FROM barber_style_gallery WHERE id = $1::uuid`, [parsed.rawId]);
      if (img.rows?.[0]?.image_url) {
        await dbQuery(`UPDATE barber_services SET image_url = $2 WHERE id = $1`, [
          serviceId,
          img.rows[0].image_url,
        ]);
      }
    }
    return { ok: true };
  }
  if (parsed.source === "service") {
    return { ok: true, message: "Service cover image is already the primary service photo." };
  }
  return { ok: false, message: "Cover image can only be set for gallery photos." };
}

export async function deleteDiscoverPhoto(discoverId) {
  const parsed = parseDiscoverPhotoId(discoverId);
  if (!parsed) return { ok: false, message: "Invalid photo id." };
  if (parsed.source === "gallery") {
    await dbQuery(`DELETE FROM barber_style_gallery WHERE id = $1::uuid`, [parsed.rawId]);
    return { ok: true };
  }
  if (parsed.source === "service") {
    await dbQuery(`UPDATE barber_services SET image_url = NULL WHERE id::text = $1::text`, [parsed.serviceId]);
    return { ok: true };
  }
  await dbQuery(`DELETE FROM review_photos WHERE id = $1::uuid`, [parsed.rawId]);
  return { ok: true };
}

export async function replaceDiscoverPhotoImage(discoverId, imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!url) return { ok: false, message: "imageUrl required." };
  const parsed = parseDiscoverPhotoId(discoverId);
  if (!parsed) return { ok: false, message: "Invalid photo id." };
  if (parsed.source === "gallery") {
    await dbQuery(`UPDATE barber_style_gallery SET image_url = $2 WHERE id = $1::uuid`, [parsed.rawId, url]);
    return { ok: true, imageUrl: bustImageCacheUrl(url, Date.now()) };
  }
  if (parsed.source === "service") {
    await dbQuery(`UPDATE barber_services SET image_url = $2 WHERE id::text = $1::text`, [
      parsed.serviceId,
      url,
    ]);
    return { ok: true, imageUrl: bustImageCacheUrl(url, Date.now()) };
  }
  await dbQuery(
    `UPDATE review_photos SET photo_url = $2, thumbnail_url = $2 WHERE id = $1::uuid`,
    [parsed.rawId, url],
  );
  return { ok: true, imageUrl: bustImageCacheUrl(url, Date.now()) };
}

function buildDiscoverPhotoEntry({
  id,
  barberId,
  barberName,
  barberSlug,
  imageUrl,
  serviceId = null,
  serviceName = "",
  price = null,
  durationMinutes = null,
  photoType = "standard",
  styleCategory = null,
  category = null,
  caption = "",
  createdAt = null,
  likedByViewer = false,
  likeCount = 0,
  source = "gallery",
  isPrimary = false,
  sortOrder = null,
  canEdit = false,
}) {
  const resolvedCategory = normalizeDiscoverCategory(styleCategory || category || "");
  const versionHint = createdAt ? new Date(createdAt).getTime() : Date.now();
  const resolved =
    resolvePublishedImageUrl(imageUrl, {
      barberId,
      serviceId: serviceId || undefined,
      styleId: id,
    }) || String(imageUrl || "");
  const url = bustImageCacheUrl(resolved, versionHint);
  if (!url) return null;
  return {
    id: String(id),
    reviewId: null,
    barberId: String(barberId),
    photoUrl: url,
    thumbnailUrl: url,
    caption: caption || serviceName || "",
    title: caption || serviceName || "",
    photoType,
    styleCategory: resolvedCategory,
    source,
    isPrimary: Boolean(isPrimary),
    sortOrder: sortOrder != null ? Number(sortOrder) : null,
    is30DayFollowup: false,
    parentPhotoId: null,
    likeCount,
    likedByViewer,
    canEdit: Boolean(canEdit),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    barberName,
    barberSlug,
    serviceId: serviceId != null ? String(serviceId) : null,
    serviceName: serviceName || caption || "",
    price: price != null && Number.isFinite(Number(price)) ? Number(price) : null,
    durationMinutes:
      durationMinutes != null && Number.isFinite(Number(durationMinutes))
        ? Number(durationMinutes)
        : null,
    createdAtMs: createdAt ? new Date(createdAt).getTime() : 0,
  };
}

export async function listDiscoverPhotos({
  styleCategory = null,
  limit = 24,
  viewerUserId = null,
  viewer = null,
} = {}) {
  const cap = Math.min(Math.max(Number(limit) || 24, 1), 100);
  let filterCategory = styleCategory ? String(styleCategory).trim() : null;
  if (filterCategory) {
    filterCategory = normalizeDiscoverCategory(filterCategory);
    if (!HAIRCUT_CATEGORY_IDS.has(filterCategory)) {
      return { ok: false, message: "Invalid style category." };
    }
  }

  const fetchLimit = Math.min(cap * 4, 200);
  const editContext = await resolveDiscoverEditContext(viewer || (viewerUserId ? { id: viewerUserId } : null));

  const reviewParams = [];
  const reviewWhere = [`rp.status = 'published'`, `lower(coalesce(b.verification_status, 'approved')) = 'approved'`];
  reviewParams.push(fetchLimit);
  const reviewR = await dbQuery(
    `SELECT rp.*, b.name AS barber_name, b.public_slug AS barber_slug, b.business_id AS barber_business_id,
            EXISTS (
              SELECT 1 FROM photo_likes pl
              WHERE pl.photo_id = rp.id AND pl.user_id = $${reviewParams.length + 1}::uuid
            ) AS liked_by_viewer
     FROM review_photos rp
     JOIN barbers b ON b.id::text = rp.barber_id
     WHERE ${reviewWhere.join(" AND ")}
     ORDER BY rp.created_at DESC
     LIMIT $${reviewParams.length}`,
    [...reviewParams, viewerUserId || editContext?.userId || null],
  );

  const serviceR = await dbQuery(
    `SELECT s.id AS service_id, s.barber_id, s.name AS service_name, s.price, s.duration_minutes,
            s.image_url, s.category, s.created_at,
            b.name AS barber_name, b.public_slug AS barber_slug, b.business_id AS barber_business_id
     FROM barber_services s
     JOIN barbers b ON b.id::text = s.barber_id::text
     WHERE COALESCE(s.is_active, true) = true
       AND s.image_url IS NOT NULL AND trim(s.image_url) <> ''
       AND lower(coalesce(b.verification_status, 'approved')) = 'approved'
     ORDER BY s.created_at DESC NULLS LAST
     LIMIT $1`,
    [fetchLimit],
  ).catch(() => ({ rows: [] }));

  const styleR = await dbQuery(
    `SELECT g.id, g.barber_id, g.service_id, g.image_url, g.title, g.description, g.price, g.duration_minutes,
            g.category, g.created_at, g.is_primary, g.sort_order,
            b.name AS barber_name, b.public_slug AS barber_slug, b.business_id AS barber_business_id,
            s.name AS linked_service_name, s.price AS linked_service_price,
            s.duration_minutes AS linked_service_duration
     FROM barber_style_gallery g
     JOIN barbers b ON b.id::text = g.barber_id::text
     LEFT JOIN barber_services s ON s.id = g.service_id
     WHERE COALESCE(g.is_published, true) = true
       AND g.image_url IS NOT NULL AND trim(g.image_url) <> ''
       AND lower(coalesce(b.verification_status, 'approved')) = 'approved'
     ORDER BY g.created_at DESC
     LIMIT $1`,
    [fetchLimit],
  ).catch(() => ({ rows: [] }));

  const serviceKeys = new Set();
  const items = [];

  for (const row of serviceR.rows || []) {
    if (
      !rowMatchesDiscoverCategory(filterCategory, {
        category: row.category,
        name: row.service_name,
        serviceName: row.service_name,
      })
    ) {
      continue;
    }
    const barberId = String(row.barber_id);
    const serviceId = row.service_id;
    const key = `${barberId}:svc:${serviceId}`;
    if (serviceKeys.has(key)) continue;
    serviceKeys.add(key);
    const entry = buildDiscoverPhotoEntry({
      id: `svc-${serviceId}-${barberId}`,
      barberId,
      barberName: row.barber_name,
      barberSlug: row.barber_slug,
      imageUrl: row.image_url,
      serviceId,
      serviceName: row.service_name,
      price: row.price,
      durationMinutes: row.duration_minutes,
      photoType: "service",
      category: row.category,
      styleCategory: row.category,
      createdAt: row.created_at,
      source: "service",
      canEdit: canEditDiscoverBarber(editContext, barberId, row.barber_business_id),
    });
    if (entry) items.push(entry);
  }

  for (const row of styleR.rows || []) {
    const barberId = String(row.barber_id);
    const sid = row.service_id != null ? String(row.service_id) : "";
    if (sid && serviceKeys.has(`${barberId}:svc:${sid}`)) continue;

    const serviceName = row.linked_service_name || row.title || "";
    const price = row.linked_service_price != null ? row.linked_service_price : row.price;
    if (
      !rowMatchesDiscoverCategory(filterCategory, {
        category: row.category,
        title: row.title,
        name: serviceName,
        serviceName,
        caption: row.description,
      })
    ) {
      continue;
    }

    const entry = buildDiscoverPhotoEntry({
      id: `gal-${String(row.id)}`,
      barberId,
      barberName: row.barber_name,
      barberSlug: row.barber_slug,
      imageUrl: row.image_url,
      serviceId: row.service_id,
      serviceName,
      price,
      durationMinutes: row.linked_service_duration ?? row.duration_minutes,
      photoType: sid ? "service" : "standard",
      caption: row.title || serviceName,
      category: row.category,
      styleCategory: row.category,
      createdAt: row.created_at,
      source: "gallery",
      isPrimary: row.is_primary,
      sortOrder: row.sort_order,
      canEdit: canEditDiscoverBarber(editContext, barberId, row.barber_business_id),
    });
    if (entry) items.push(entry);
  }

  for (const row of reviewR.rows || []) {
    const mapped = mapPhotoRow(row, { likedByViewer: Boolean(row.liked_by_viewer) });
    const normalizedCat = normalizeDiscoverCategory(mapped.styleCategory || mapped.caption || "");
    if (
      !rowMatchesDiscoverCategory(filterCategory, {
        styleCategory: mapped.styleCategory,
        category: mapped.styleCategory,
        title: mapped.caption,
        caption: mapped.caption,
        name: row.barber_name,
      })
    ) {
      continue;
    }
    const versionHint = row.created_at ? new Date(row.created_at).getTime() : Date.now();
    items.push({
      ...mapped,
      styleCategory: normalizedCat,
      photoUrl: bustImageCacheUrl(mapped.photoUrl, versionHint),
      thumbnailUrl: bustImageCacheUrl(mapped.thumbnailUrl || mapped.photoUrl, versionHint),
      title: mapped.caption || "",
      source: "review",
      canEdit: canEditDiscoverBarber(editContext, mapped.barberId, row.barber_business_id),
      barberName: row.barber_name,
      barberSlug: row.barber_slug,
      serviceName: mapped.caption || "",
      price: null,
      createdAtMs: row.created_at ? new Date(row.created_at).getTime() : 0,
    });
  }

  const photos = items
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
    .slice(0, cap)
    .map(({ createdAtMs, ...rest }) => rest);

  return { ok: true, photos, styleCategory: filterCategory || null };
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

  void import("./reviewNotificationEmail.cjs")
    .then((m) =>
      m.emailBarberNewReview({
        dbQuery,
        barberId,
        rating: normalizedRating,
        comment: review.comment,
        customerName: "A verified client",
      }),
    )
    .catch(() => {});

  try {
    const pushNotifier = require("./pushNotifier.cjs");
    const barberUsers = await dbQuery(
      `SELECT user_id AS id FROM barbers WHERE id::text = $1::text AND user_id IS NOT NULL
       UNION
       SELECT id FROM app_users WHERE barber_id::text = $1::text AND role = 'barber'`,
      [barberId],
    );
    const userIds = [...new Set((barberUsers.rows || []).map((r) => String(r.id)).filter(Boolean))];
    if (userIds.length) {
      await pushNotifier.sendPushToUsers({
        dbQuery,
        userIds,
        kind: "admin_alert",
        title: "New client review",
        body: `You received a ${normalizedRating}★ review.`,
        data: { type: "new_review", barberId, reviewId: String(review.id) },
      });
    }
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    review: mapReviewRow(review, savedPhotos),
  };
}

export async function replyToBarberReview({ userId, reviewId, reply }) {
  const r = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = r.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };
  if (String(review.status || "").toLowerCase() === "hidden") {
    return { ok: false, message: "Cannot reply to a hidden review." };
  }

  const allowed = await assertUserCanReplyAsBarber(userId, review.barber_id);
  if (!allowed.ok) return allowed;

  const text = String(reply || "").trim();
  if (!text) return { ok: false, message: "Reply cannot be empty." };
  if (text.length > 2000) return { ok: false, message: "Reply is too long." };

  const upd = await dbQuery(
    `UPDATE barber_reviews
     SET barber_reply = $2,
         barber_reply_at = NOW(),
         barber_reply_by = $3::uuid,
         updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING *`,
    [String(reviewId), text, userId],
  );
  const updated = upd.rows?.[0];
  const photos = await loadPhotosForReviews([updated.id], userId);
  return {
    ok: true,
    review: mapReviewRow(
      { ...updated, customer_name: "Verified customer" },
      photos.get(String(updated.id)) || [],
    ),
  };
}

export async function adminDeleteReview(reviewId, { adminUserId, reason = "" } = {}) {
  const r = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = r.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };

  const photos = await loadPhotosForReviews([review.id], null);
  const snapshot = {
    ...mapReviewRow(review, photos.get(String(review.id)) || []),
    status: review.status,
  };

  let barberName = "";
  let shopName = "";
  let customerEmail = "";
  let customerName = "Verified customer";
  try {
    const br = await dbQuery(
      `SELECT b.name AS barber_name, bs.name AS shop_name, bk.customer_email, bk.customer_name, u.email AS user_email
       FROM barber_reviews r
       LEFT JOIN barbers b ON b.id::text = r.barber_id
       LEFT JOIN businesses bs ON bs.id = b.business_id
       LEFT JOIN bookings bk ON bk.id = r.booking_id
       LEFT JOIN app_users u ON u.id = r.customer_user_id
       WHERE r.id = $1::uuid LIMIT 1`,
      [String(reviewId)],
    );
    barberName = br.rows?.[0]?.barber_name || "";
    shopName = br.rows?.[0]?.shop_name || "";
    customerEmail = br.rows?.[0]?.customer_email || br.rows?.[0]?.user_email || "";
    customerName = br.rows?.[0]?.customer_name || customerName;
  } catch {
    /* ignore */
  }

  await dbQuery(
    `UPDATE barber_reviews
     SET status = 'removed',
         deleted_at = COALESCE(deleted_at, NOW()),
         deleted_by = $2::uuid,
         delete_reason = $3,
         moderated_at = NOW(),
         moderated_by = $2::uuid,
         moderation_reason = $3,
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [String(reviewId), adminUserId || null, reason || "policy_violation"],
  );

  await dbQuery(
    `INSERT INTO review_moderation_logs (review_id, action, reason, admin_user_id, snapshot)
     VALUES ($1::uuid, 'removed', $2, $3::uuid, $4::jsonb)`,
    [String(reviewId), reason || "policy_violation", adminUserId || null, JSON.stringify(snapshot)],
  ).catch(() => {});

  void import("./reviewNotificationEmail.cjs")
    .then((m) =>
      m.emailAdminReviewModeration({
        action: "removed",
        targetType: "review",
        targetId: String(reviewId),
        bookingId: review.booking_id,
        reason: reason || "admin_removed",
        details: `Soft-deleted by admin ${adminUserId || ""}`,
        barberName,
        shopName,
        customerName,
        customerEmail,
        rating: review.rating,
        comment: review.comment,
        photoUrls: (snapshot.photos || []).map((p) => p.photoUrl).filter(Boolean),
        adminNotes: reason || "",
        adminUserId,
      }),
    )
    .catch(() => {});

  return { ok: true, message: "Review removed from public view." };
}

export async function restoreReview(reviewId, { adminUserId, reason = "" } = {}) {
  const r = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = r.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };

  await dbQuery(
    `UPDATE barber_reviews
     SET status = 'published',
         deleted_at = NULL,
         deleted_by = NULL,
         delete_reason = NULL,
         moderated_at = NOW(),
         moderated_by = $2::uuid,
         moderation_reason = $3,
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [String(reviewId), adminUserId || null, reason || "restored"],
  );

  await dbQuery(
    `INSERT INTO review_moderation_logs (review_id, action, reason, admin_user_id, snapshot)
     VALUES ($1::uuid, 'restored', $2, $3::uuid, $4::jsonb)`,
    [
      String(reviewId),
      reason || "restored",
      adminUserId || null,
      JSON.stringify({ rating: review.rating, comment: review.comment, bookingId: review.booking_id }),
    ],
  ).catch(() => {});

  let barberName = "";
  try {
    const br = await dbQuery(`SELECT name FROM barbers WHERE id::text = $1::text LIMIT 1`, [
      String(review.barber_id),
    ]);
    barberName = br.rows?.[0]?.name || "";
  } catch {
    /* ignore */
  }

  void import("./reviewNotificationEmail.cjs")
    .then((m) =>
      m.emailAdminReviewModeration({
        action: "restored",
        targetType: "review",
        targetId: String(reviewId),
        bookingId: review.booking_id,
        reason: reason || "restored",
        barberName,
        rating: review.rating,
        comment: review.comment,
        adminUserId,
      }),
    )
    .catch(() => {});

  return { ok: true, message: "Review restored to public view." };
}

export async function clearBarberReply({ userId, reviewId }) {
  const r = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = r.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };
  const allowed = await assertUserCanReplyAsBarber(userId, review.barber_id);
  if (!allowed.ok) return allowed;

  const upd = await dbQuery(
    `UPDATE barber_reviews
     SET barber_reply = NULL, barber_reply_at = NULL, barber_reply_by = NULL, updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING *`,
    [String(reviewId)],
  );
  const updated = upd.rows?.[0];
  const photos = await loadPhotosForReviews([updated.id], userId);
  return {
    ok: true,
    review: mapReviewRow(
      { ...updated, customer_name: "Verified customer" },
      photos.get(String(updated.id)) || [],
    ),
  };
}

/** Push + email clients to leave a review after appointment completion (once per booking). */
export async function notifyCustomerReviewPrompt(bookingRow) {
  if (!bookingRow?.id) return { ok: false, reason: "missing_booking" };
  if (String(bookingRow.booking_status || "").toLowerCase() !== "completed") {
    return { ok: false, reason: "not_completed" };
  }

  const bookingId = String(bookingRow.id);
  const barberName = String(bookingRow.barber_name || "your provider");
  const customerName = String(bookingRow.customer_name || "").trim();
  const customerEmail = String(bookingRow.customer_email || "").trim();
  const userId = bookingRow.user_id ? String(bookingRow.user_id) : null;

  // Claim the prompt slot once — concurrent completes lose on unique index.
  try {
    const claim = await dbQuery(
      `UPDATE bookings
       SET review_prompt_sent_at = NOW()
       WHERE id = $1::uuid
         AND review_prompt_sent_at IS NULL
       RETURNING id`,
      [bookingId],
    );
    if (!claim.rows?.[0]) {
      return { ok: true, skipped: "already_sent" };
    }
  } catch (e) {
    console.warn("[review-prompt] claim failed:", e?.message || e);
  }

  const deepLinkApp = `ifcdc-barbers://review/${bookingId}`;
  const deepLinkWeb = `${String(process.env.PUBLIC_WEB_URL || process.env.EXPO_PUBLIC_WEB_URL || "https://ifcdcbarbersapp.com").replace(/\/$/, "")}/profile/bookings/${encodeURIComponent(bookingId)}/review`;

  let emailStatus = "skipped";
  let emailError = null;
  try {
    const mail = await import("./reviewNotificationEmail.cjs").then((m) =>
      m.emailCustomerReviewPrompt({
        to: customerEmail,
        customerName,
        barberName,
        bookingId,
        deepLinkApp,
        deepLinkWeb,
      }),
    );
    emailStatus = mail?.ok === false ? "failed" : customerEmail ? "sent" : "skipped";
    emailError = mail?.reason || null;
  } catch (e) {
    emailStatus = "failed";
    emailError = e?.message || String(e);
  }

  await dbQuery(
    `INSERT INTO notification_delivery_logs (booking_id, channel, kind, recipient, status, error_message, metadata)
     VALUES ($1::uuid, 'email', 'review_prompt', $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      bookingId,
      customerEmail || null,
      emailStatus,
      emailError,
      JSON.stringify({ deepLinkWeb, deepLinkApp, barberName }),
    ],
  ).catch(() => {});

  let pushStatus = "skipped";
  let pushError = null;
  if (userId) {
    try {
      const pushNotifier = require("./pushNotifier.cjs");
      await pushNotifier.sendPushToUsers({
        dbQuery,
        userIds: [userId],
        kind: "booking_status_update",
        title: "Your appointment is complete",
        body: `Your appointment is complete. How was your experience with ${barberName}? Tap here to leave a rating, review, and photos.`,
        data: {
          type: "leave_review",
          bookingId,
          barberId: String(bookingRow.barber_id || ""),
          url: deepLinkApp,
          webUrl: deepLinkWeb,
        },
      });
      pushStatus = "sent";
    } catch (e) {
      pushStatus = "failed";
      pushError = e?.message || String(e);
    }
  }

  await dbQuery(
    `INSERT INTO notification_delivery_logs (booking_id, channel, kind, recipient, status, error_message, metadata)
     VALUES ($1::uuid, 'push', 'review_prompt', $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      bookingId,
      userId || null,
      pushStatus,
      pushError,
      JSON.stringify({ deepLinkApp, deepLinkWeb }),
    ],
  ).catch(() => {});

  return { ok: true, emailStatus, pushStatus };
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePhotoLikeTarget(photoId) {
  const raw = String(photoId || "").trim();
  if (!raw) return { kind: "invalid" };
  if (raw.startsWith("gal-")) {
    const galleryId = raw.slice(4);
    if (UUID_RE.test(galleryId)) return { kind: "gallery", galleryId };
    return { kind: "invalid" };
  }
  if (raw.startsWith("svc-")) {
    const rest = raw.slice(4);
    const dashIdx = rest.indexOf("-");
    if (dashIdx === -1) {
      return { kind: "service_cover", serviceId: rest, barberId: null };
    }
    return {
      kind: "service_cover",
      serviceId: rest.slice(0, dashIdx),
      barberId: rest.slice(dashIdx + 1),
    };
  }
  if (UUID_RE.test(raw)) return { kind: "review_photo", photoId: raw };
  return { kind: "invalid" };
}

async function resolveGalleryIdForServiceCover(serviceId, barberId = null) {
  const sid = String(serviceId || "").trim();
  if (!sid) return null;

  const params = [sid];
  let barberClause = "";
  if (barberId) {
    params.push(String(barberId));
    barberClause = ` AND g.barber_id::text = $2::text`;
  }

  const existing = await dbQuery(
    `SELECT g.id::text AS id
     FROM barber_style_gallery g
     WHERE g.service_id::text = $1::text${barberClause}
     ORDER BY COALESCE(g.is_primary, false) DESC, g.sort_order ASC, g.created_at DESC
     LIMIT 1`,
    params,
  );
  if (existing.rows?.[0]?.id) return String(existing.rows[0].id);

  const svc = await dbQuery(
    `SELECT s.id, s.barber_id, s.name, s.description, s.category, s.price, s.duration_minutes, s.image_url
     FROM barber_services s
     WHERE s.id::text = $1::text
     LIMIT 1`,
    [sid],
  );
  const row = svc.rows?.[0];
  if (!row?.image_url) return null;

  const bid = barberId ? String(barberId) : String(row.barber_id);
  const ins = await dbQuery(
    `INSERT INTO barber_style_gallery
       (barber_id, service_id, title, description, category, price, duration_minutes, image_url, sort_order, is_published, is_primary)
     VALUES ($1::text, $2, $3, $4, $5, $6, $7, $8, 0, true, true)
     RETURNING id::text AS id`,
    [
      bid,
      sid,
      row.name || "Service",
      row.description || null,
      row.category || "other",
      Number(row.price) || 0,
      Number(row.duration_minutes) || 30,
      String(row.image_url).trim(),
    ],
  ).catch(() => ({ rows: [] }));
  return ins.rows?.[0]?.id ? String(ins.rows[0].id) : null;
}

async function toggleStyleGalleryLike(userId, galleryId) {
  const gid = String(galleryId);
  const photo = await dbQuery(
    `SELECT id, COALESCE(like_count, 0)::int AS like_count
     FROM barber_style_gallery WHERE id = $1::uuid LIMIT 1`,
    [gid],
  );
  if (!photo.rows?.[0]) {
    return { ok: false, message: "Photo not found.", code: "gallery_not_found" };
  }

  const existing = await dbQuery(
    `SELECT id FROM style_gallery_likes WHERE gallery_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
    [gid, userId],
  );
  if (existing.rows?.length) {
    await dbQuery(`DELETE FROM style_gallery_likes WHERE gallery_id = $1::uuid AND user_id = $2::uuid`, [
      gid,
      userId,
    ]);
    const upd = await dbQuery(
      `UPDATE barber_style_gallery SET like_count = GREATEST(COALESCE(like_count, 0) - 1, 0)
       WHERE id = $1::uuid RETURNING COALESCE(like_count, 0)::int AS like_count`,
      [gid],
    );
    return {
      ok: true,
      liked: false,
      likeCount: Number(upd.rows?.[0]?.like_count) || 0,
    };
  }

  await dbQuery(`INSERT INTO style_gallery_likes (gallery_id, user_id) VALUES ($1::uuid, $2::uuid)`, [
    gid,
    userId,
  ]);
  const upd = await dbQuery(
    `UPDATE barber_style_gallery SET like_count = COALESCE(like_count, 0) + 1
     WHERE id = $1::uuid RETURNING COALESCE(like_count, 0)::int AS like_count`,
    [gid],
  );
  return {
    ok: true,
    liked: true,
    likeCount: Number(upd.rows?.[0]?.like_count) || 0,
  };
}

async function toggleReviewPhotoLike(userId, photoId) {
  const pid = String(photoId);
  const photo = await dbQuery(
    `SELECT id, COALESCE(like_count, 0)::int AS like_count FROM review_photos WHERE id = $1::uuid LIMIT 1`,
    [pid],
  );
  if (!photo.rows?.[0]) {
    return { ok: false, message: "Photo not found.", code: "review_photo_not_found" };
  }

  const existing = await dbQuery(
    `SELECT id FROM photo_likes WHERE photo_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
    [pid, userId],
  );
  if (existing.rows?.length) {
    await dbQuery(`DELETE FROM photo_likes WHERE photo_id = $1::uuid AND user_id = $2::uuid`, [pid, userId]);
    const upd = await dbQuery(
      `UPDATE review_photos SET like_count = GREATEST(COALESCE(like_count, 0) - 1, 0)
       WHERE id = $1::uuid RETURNING COALESCE(like_count, 0)::int AS like_count`,
      [pid],
    );
    return {
      ok: true,
      liked: false,
      likeCount: Number(upd.rows?.[0]?.like_count) || 0,
    };
  }

  await dbQuery(`INSERT INTO photo_likes (photo_id, user_id) VALUES ($1::uuid, $2::uuid)`, [pid, userId]);
  const upd = await dbQuery(
    `UPDATE review_photos SET like_count = COALESCE(like_count, 0) + 1
     WHERE id = $1::uuid RETURNING COALESCE(like_count, 0)::int AS like_count`,
    [pid],
  );
  return {
    ok: true,
    liked: true,
    likeCount: Number(upd.rows?.[0]?.like_count) || 0,
  };
}

export async function togglePhotoLike(userId, photoId) {
  if (!userId) {
    return { ok: false, message: "Sign in to like photos.", code: "auth_required" };
  }

  const target = parsePhotoLikeTarget(photoId);
  if (target.kind === "invalid") {
    return { ok: false, message: "Photo not found.", code: "invalid_photo_id" };
  }
  if (target.kind === "gallery") {
    return toggleStyleGalleryLike(userId, target.galleryId);
  }
  if (target.kind === "service_cover") {
    const galleryId = await resolveGalleryIdForServiceCover(target.serviceId, target.barberId);
    if (!galleryId) {
      return { ok: false, message: "Photo not found.", code: "gallery_resolve_failed" };
    }
    return toggleStyleGalleryLike(userId, galleryId);
  }
  return toggleReviewPhotoLike(userId, target.photoId);
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
  let barberName = "";
  if (t === "review") {
    await dbQuery(`UPDATE barber_reviews SET status = 'reported' WHERE id = $1::uuid`, [String(targetId)]).catch(
      () => {},
    );
    try {
      const rr = await dbQuery(
        `SELECT b.name FROM barber_reviews r
         LEFT JOIN barbers b ON b.id::text = r.barber_id
         WHERE r.id = $1::uuid LIMIT 1`,
        [String(targetId)],
      );
      barberName = rr.rows?.[0]?.name || "";
    } catch {
      /* ignore */
    }
  } else {
    await dbQuery(`UPDATE review_photos SET status = 'reported' WHERE id = $1::uuid`, [String(targetId)]).catch(
      () => {},
    );
    try {
      const pr = await dbQuery(
        `SELECT b.name FROM review_photos p
         LEFT JOIN barbers b ON b.id::text = p.barber_id
         WHERE p.id = $1::uuid LIMIT 1`,
        [String(targetId)],
      );
      barberName = pr.rows?.[0]?.name || "";
    } catch {
      /* ignore */
    }
  }

  void import("./reviewNotificationEmail.cjs")
    .then((m) =>
      m.emailAdminReviewModeration({
        action: "reported",
        targetType: t,
        targetId: String(targetId),
        reason: String(reason || "other"),
        details: String(details || ""),
        barberName,
      }),
    )
    .catch(() => {});

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

export async function setReviewVisibility(reviewId, status, { adminUserId, reason = "" } = {}) {
  const s = String(status || "").toLowerCase();
  if (!["published", "hidden"].includes(s)) return { ok: false, message: "Invalid status." };
  const existing = await dbQuery(`SELECT * FROM barber_reviews WHERE id = $1::uuid LIMIT 1`, [String(reviewId)]);
  const review = existing.rows?.[0];
  if (!review) return { ok: false, message: "Review not found." };

  await dbQuery(
    `UPDATE barber_reviews
     SET status = $2,
         deleted_at = CASE WHEN $2 = 'published' THEN NULL ELSE deleted_at END,
         moderated_at = NOW(),
         moderated_by = $3::uuid,
         moderation_reason = $4,
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [String(reviewId), s, adminUserId || null, reason || s],
  );

  await dbQuery(
    `INSERT INTO review_moderation_logs (review_id, action, reason, admin_user_id, snapshot)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb)`,
    [
      String(reviewId),
      s === "hidden" ? "hidden" : "restored",
      reason || s,
      adminUserId || null,
      JSON.stringify({ rating: review.rating, comment: review.comment, bookingId: review.booking_id }),
    ],
  ).catch(() => {});

  let barberName = "";
  let customerEmail = "";
  let customerName = "";
  let shopName = "";
  try {
    const br = await dbQuery(
      `SELECT b.name AS barber_name, bs.name AS shop_name, bk.customer_email, bk.customer_name, u.email AS user_email
       FROM barber_reviews r
       LEFT JOIN barbers b ON b.id::text = r.barber_id
       LEFT JOIN businesses bs ON bs.id = b.business_id
       LEFT JOIN bookings bk ON bk.id = r.booking_id
       LEFT JOIN app_users u ON u.id = r.customer_user_id
       WHERE r.id = $1::uuid LIMIT 1`,
      [String(reviewId)],
    );
    barberName = br.rows?.[0]?.barber_name || "";
    shopName = br.rows?.[0]?.shop_name || "";
    customerEmail = br.rows?.[0]?.customer_email || br.rows?.[0]?.user_email || "";
    customerName = br.rows?.[0]?.customer_name || "";
  } catch {
    /* ignore */
  }

  void import("./reviewNotificationEmail.cjs")
    .then((m) =>
      m.emailAdminReviewModeration({
        action: s === "hidden" ? "hidden" : "restored",
        targetType: "review",
        targetId: String(reviewId),
        bookingId: review.booking_id,
        reason: reason || s,
        details: `${s} by admin ${adminUserId || ""}`,
        barberName,
        shopName,
        customerName,
        customerEmail,
        rating: review.rating,
        comment: review.comment,
        adminNotes: reason || "",
        adminUserId,
      }),
    )
    .catch(() => {});

  return { ok: true };
}

export async function listAdminReviews({
  q = "",
  status = "",
  stars = "",
  hasPhotos = "",
  limit = 50,
  offset = 0,
} = {}) {
  const clauses = ["1=1"];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const statusFilter = String(status || "").trim().toLowerCase();
  if (statusFilter && statusFilter !== "all") {
    if (statusFilter === "removed") clauses.push(`(r.status = 'removed' OR r.deleted_at IS NOT NULL)`);
    else if (statusFilter === "hidden") clauses.push(`r.status = 'hidden'`);
    else if (statusFilter === "reported") clauses.push(`r.status = 'reported'`);
    else if (statusFilter === "published") clauses.push(`r.status = 'published' AND r.deleted_at IS NULL`);
    else clauses.push(`r.status = ${add(statusFilter)}`);
  }

  const starN = Number(stars);
  if (Number.isFinite(starN) && starN >= 1 && starN <= 5) {
    clauses.push(`r.rating = ${add(starN)}`);
  }

  if (String(hasPhotos).toLowerCase() === "true" || hasPhotos === "1") {
    clauses.push(
      `EXISTS (SELECT 1 FROM review_photos rp WHERE rp.review_id = r.id AND rp.status = 'published')`,
    );
  } else if (String(hasPhotos).toLowerCase() === "false" || hasPhotos === "0") {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM review_photos rp WHERE rp.review_id = r.id AND rp.status = 'published')`,
    );
  }

  const query = String(q || "").trim();
  if (query) {
    const like = `%${query}%`;
    const p = add(like);
    clauses.push(`(
      coalesce(u.name,'') ILIKE ${p}
      OR coalesce(u.email,'') ILIKE ${p}
      OR coalesce(bk.customer_name,'') ILIKE ${p}
      OR coalesce(bk.customer_email,'') ILIKE ${p}
      OR coalesce(b.name,'') ILIKE ${p}
      OR coalesce(bs.name,'') ILIKE ${p}
      OR r.id::text ILIKE ${p}
      OR r.booking_id::text ILIKE ${p}
      OR coalesce(r.comment,'') ILIKE ${p}
    )`);
  }

  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  params.push(lim, off);

  const rows = await dbQuery(
    `SELECT r.*,
            COALESCE(u.name, bk.customer_name, 'Verified customer') AS customer_name,
            COALESCE(u.email, bk.customer_email) AS customer_email,
            b.name AS barber_name,
            bs.name AS shop_name
     FROM barber_reviews r
     LEFT JOIN app_users u ON u.id = r.customer_user_id
     LEFT JOIN bookings bk ON bk.id = r.booking_id
     LEFT JOIN barbers b ON b.id::text = r.barber_id
     LEFT JOIN businesses bs ON bs.id = b.business_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY r.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const reviewIds = (rows.rows || []).map((row) => row.id);
  const photos = await loadPhotosForReviews(reviewIds, null);
  return {
    ok: true,
    reviews: (rows.rows || []).map((row) => ({
      ...mapReviewRow(row, photos.get(String(row.id)) || []),
      status: row.status,
      deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      moderatedAt: row.moderated_at ? new Date(row.moderated_at).toISOString() : null,
      moderationReason: row.moderation_reason || "",
      customerEmail: row.customer_email || "",
      barberName: row.barber_name || "",
      shopName: row.shop_name || "",
    })),
  };
}

export async function setPhotoVisibility(photoId, status) {
  return setDiscoverPhotoVisibility(photoId, status);
}

export async function listReviewableBookings(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  try {
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
      [uid],
    );
    return (r.rows || []).map((row) => ({
      id: String(row.id),
      barberId: String(row.barber_id),
      barberName: row.barber_name || "",
      service: row.service || "",
      date: row.date,
      time: row.time,
    }));
  } catch (e) {
    const msg = String(e?.message || e);
    if (/barber_reviews|does not exist|invalid input syntax for type uuid/i.test(msg)) {
      console.warn("[portfolio] reviewable bookings fallback:", msg);
      return [];
    }
    throw e;
  }
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
