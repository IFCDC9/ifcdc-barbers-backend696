import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { dbQuery } from "./db.js";
import { requireAuth } from "./authRoutes.js";
import {
  resolveScopedBarberId,
  buildPublicBarberPricingResponse,
  loadBarberSettingsRow,
} from "./barberScope.js";
import { getBusinessScopeForUser } from "./authBusinessScope.js";
import { isJwtGlobalSuperScope } from "./authPlatformJwt.js";
import { createRequire } from "node:module";
import {
  normalizeBillingProvider,
  normalizeTier,
  TIER_FREE,
  validateSubscriptionMonthlyPrice,
} from "./subscriptionTier.js";
import { logServiceAudit, logServiceUpdateDiff } from "./serviceAuditLog.js";
import { writeSecurityAudit } from "./auditSecurity.js";
import { uploadBarberStyleImage } from "./src/services/storageUpload.js";

function actorFromReq(req) {
  return {
    id: req?.user?.id ? String(req.user.id) : null,
    role: req?.user?.role ? String(req.user.role) : null,
    email: req?.user?.email ? String(req.user.email) : null,
  };
}

const requireCjs = createRequire(import.meta.url);
const { handlePublicBarberServicesGet } = requireCjs("./bookingPublicHandlers.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

/** Accept businessId or business_id from query string or JSON body. */
function extractBusinessIdFromRequest(req) {
  const q = req?.query && typeof req.query === "object" ? req.query : {};
  const b = req?.body && typeof req.body === "object" ? req.body : {};
  const raw = q.businessId ?? q.business_id ?? b.businessId ?? b.business_id ?? "";
  return String(raw).trim();
}

function canManageShopsRole(user) {
  const role = String(user?.role || "").trim().toLowerCase();
  return isJwtGlobalSuperScope(user) || role === "admin" || role === "shop_owner";
}

async function queryShopRows(whereClause = "", params = []) {
  const r = await dbQuery(
    `SELECT
       b.id AS business_id,
       b.name,
       b.phone,
       b.plan,
       COALESCE(b.subscription_status, 'active') AS status,
       (
         SELECT u.name FROM app_users u
         WHERE u.business_id = b.id AND u.role = 'shop_owner'
         LIMIT 1
       ) AS owner_name,
       (
         SELECT COUNT(*)::int FROM barbers br WHERE br.business_id = b.id
       ) AS barber_count,
       (
         SELECT COUNT(*)::int FROM bookings bk WHERE bk.business_id = b.id
       ) AS booking_count
     FROM businesses b
     ${whereClause}
     ORDER BY b.name ASC NULLS LAST
     LIMIT 500`,
    params,
  );
  return r.rows || [];
}

async function assertShopAccess(user, businessIdRaw) {
  if (!canManageShopsRole(user)) {
    return { error: "forbidden", status: 403, message: "Shop management is for admins and shop owners." };
  }
  if (isJwtGlobalSuperScope(user) || String(user?.role || "").trim().toLowerCase() === "admin") {
    const idText = String(businessIdRaw || "").trim();
    if (!idText) {
      return { error: "business_id_required", status: 400, message: "Pass businessId or business_id." };
    }
    const r = await dbQuery(`SELECT id FROM businesses WHERE id::text = $1 LIMIT 1`, [idText]);
    if (!r.rows?.length) {
      return { error: "not_found", status: 404, message: "Shop not found." };
    }
    return { businessId: r.rows[0].id };
  }
  const scope = await getBusinessScopeForUser(user);
  if (scope.businessId == null) {
    return { error: "forbidden", status: 403, message: "Shop owner account is not linked to a business." };
  }
  const idText = String(businessIdRaw || scope.businessId).trim();
  if (String(scope.businessId) !== idText) {
    return { error: "forbidden", status: 403, message: "That shop is outside your scope." };
  }
  return { businessId: scope.businessId };
}

/** Accept barberId, barber_id, barberName from query or body. */
function extractBarberServicesQuery(req) {
  const q = req?.query && typeof req.query === "object" ? req.query : {};
  const b = req?.body && typeof req.body === "object" ? req.body : {};
  const barberIdRaw = String(q.barberId ?? q.barber_id ?? b.barberId ?? b.barber_id ?? "").trim();
  const barberName = String(q.barberName ?? q.barber_name ?? b.barberName ?? b.barber_name ?? "").trim();
  return { barberIdRaw, barberName };
}

/** Accept barberId or barber_id from query string or JSON body (UUID or numeric string). */
export function extractBarberIdFromRequest(req) {
  const q = req?.query && typeof req.query === "object" ? req.query : {};
  const b = req?.body && typeof req.body === "object" ? req.body : {};
  const raw = q.barberId ?? q.barber_id ?? b.barberId ?? b.barber_id ?? "";
  return String(raw).trim();
}

async function middlewareBarberScope(req, res, next) {
  try {
    const q = extractBarberIdFromRequest(req);
    const resolved = await resolveScopedBarberId(req.user, q || undefined);
    if (resolved.error) {
      return res.status(resolved.status).json({
        success: false,
        error: resolved.error,
        message: resolved.message,
      });
    }
    req.barberId = resolved.barberId;
    return next();
  } catch (e) {
    console.error("[barber-business] scope:", e);
    return res.status(500).json({ error: "scope_failed", message: e?.message || String(e) });
  }
}

export function createBarberBusinessRouter({ uploadDir } = {}) {
  const router = express.Router();

  /** Public: live deposit rules + catalog services (no auth). */
  router.get("/api/barber/public/:id/pricing", async (req, res) => {
    const bid = String(req.params.id || "").trim();
    if (!bid) {
      return res.status(400).json({ error: "invalid_barber_id", message: "Invalid barber id" });
    }
    try {
      const exists = await dbQuery(`SELECT id FROM barbers WHERE id::text = $1 LIMIT 1`, [bid]);
      if (!exists.rows?.length) {
        return res.status(404).json({ error: "not_found", message: "Barber not found" });
      }
      const payload = await buildPublicBarberPricingResponse(bid);
      return res.json(payload);
    } catch (e) {
      console.error("[barber-business] public pricing:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to load pricing" });
    }
  });

  /** Public: authoritative charge breakdown (service + platform fee + tip) for PayPal + UI. */
  router.post("/api/barber/public/:id/booking-quote", async (req, res) => {
    const bid = String(req.params.id || "").trim();
    if (!bid) {
      return res.status(400).json({ error: "invalid_barber_id", message: "Invalid barber id" });
    }
    try {
      const exists = await dbQuery(`SELECT id FROM barbers WHERE id::text = $1 LIMIT 1`, [bid]);
      if (!exists.rows?.length) {
        return res.status(404).json({ error: "not_found", message: "Barber not found" });
      }
      const { computeStyleBookingBreakdown } = await import("./bookingBreakdown.js");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const styleId = String(body.styleId || body.style_id || "").trim();
      const paymentType = body.paymentType || body.payment_type || "full";
      const out = await computeStyleBookingBreakdown({ styleId, barberId: bid, paymentType, body });
      if (!out.ok) {
        return res.status(out.status || 400).json({ error: out.error, message: out.message });
      }
      return res.json({
        ok: true,
        subscription_tier: out.subscription_tier,
        breakdown: out.breakdown,
        styleId: out.styleId,
        styleTitle: out.styleTitle,
      });
    } catch (e) {
      console.error("[barber-business] booking-quote:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to compute quote" });
    }
  });

  const baseDir = uploadDir || path.join(__dirname, "backend", "uploads");
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, baseDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 12) || ".jpg";
      cb(null, `portfolio-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });
  const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  const BRANDING_MAX_BYTES = 5 * 1024 * 1024;
  const brandingImageMime = /^image\/(jpeg|pjpeg|png|gif|webp|avif)$/i;
  function brandingFileFilter(_req, file, cb) {
    if (!file.mimetype || !brandingImageMime.test(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, GIF, WebP, or AVIF images are allowed"));
    }
    cb(null, true);
  }

  const uploadBranding = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, baseDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "").slice(0, 12).toLowerCase();
        const safe =
          ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".gif" || ext === ".webp" || ext === ".avif"
            ? ext
            : ".jpg";
        cb(null, `branding-${Date.now()}-${Math.random().toString(16).slice(2)}${safe}`);
      },
    }),
    limits: { fileSize: BRANDING_MAX_BYTES },
    fileFilter: brandingFileFilter,
  });

  function handleBrandingUpload(req, res, next) {
    uploadBranding.single("file")(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: "file_too_large",
          message: "Image must be 5MB or smaller",
        });
      }
      return res.status(400).json({
        error: "invalid_file",
        message: err.message || "Upload failed",
      });
    });
  }

  const chain = [requireAuth, middlewareBarberScope];

  /** POST /api/upload — barber-scoped; Supabase Storage (persistent public URL). */
  router.post("/api/upload", ...chain, (req, res, next) => {
    uploadMemory.single("file")(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            error: "file_too_large",
            message: "Image must be 8MB or smaller",
          });
        }
        return res.status(400).json({
          error: "invalid_file",
          message: err.message || "Upload failed",
        });
      }
      try {
        const file = req.file;
        if (!file?.buffer?.length) {
          return res.status(400).json({ error: "file_required", message: "Multipart field `file` (image) is required" });
        }
        const br = await dbQuery(`SELECT name FROM barbers WHERE id::text = $1::text LIMIT 1`, [String(req.barberId)]);
        const barberName = br.rows?.[0]?.name || `barber-${req.barberId}`;
        const { url, storage } = await uploadBarberStyleImage({
          buffer: file.buffer,
          mimetype: file.mimetype,
          barberName,
          originalName: file.originalname || "upload.jpg",
        });
        return res.status(201).json({ ok: true, url, image_url: url, storage });
      } catch (e) {
        console.error("[barber-business] POST /api/upload:", e);
        return res.status(500).json({ error: "upload_failed", message: e?.message || String(e) });
      }
    });
  });

  const registerProfile = (method, pathSuffix, ...handlers) => {
    router[method](pathSuffix, ...handlers);
  };

  // —— Profile ——
  registerProfile("get", "/api/barber/profile", ...chain, async (req, res) => {
    try {
      const bid = req.barberId;
      const r = await dbQuery(
        `SELECT b.id, b.user_id, b.name, b.bio, b.profile_image, b.logo, b.location, b.phone, b.created_at
         FROM barbers b WHERE b.id = $1 LIMIT 1`,
        [bid],
      );
      const row = r.rows?.[0];
      if (!row) return res.status(404).json({ error: "not_found", message: "Barber profile missing" });
      return res.json({ profile: row });
    } catch (e) {
      console.error("[barber-business] GET profile:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to load profile" });
    }
  });

  registerProfile("put", "/api/barber/profile", ...chain, async (req, res) => {
    try {
      const bid = req.barberId;
      const name = String(req.body?.name ?? "").trim();
      const bio = String(req.body?.bio ?? "").trim();
      const profile_image = String(req.body?.profile_image ?? req.body?.profileImage ?? "").trim() || null;
      const logo = String(req.body?.logo ?? "").trim() || null;
      const location = String(req.body?.location ?? "").trim() || null;
      const phone = String(req.body?.phone ?? "").trim() || null;

      if (name.length > 200) return res.status(400).json({ error: "validation", message: "Name too long" });
      if (bio.length > 4000) return res.status(400).json({ error: "validation", message: "Bio too long" });

      const r = await dbQuery(
        `UPDATE barbers SET
           name = COALESCE(NULLIF($2::text, ''), name),
           bio = $3,
           profile_image = $4,
           logo = $5,
           location = $6,
           phone = $7
         WHERE id = $1
         RETURNING id, user_id, name, bio, profile_image, logo, location, phone, created_at`,
        [bid, name || null, bio || null, profile_image, logo, location, phone],
      );
      return res.json({ profile: r.rows?.[0] });
    } catch (e) {
      console.error("[barber-business] PUT profile:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to save profile" });
    }
  });

  const servicesSelectSql = `
    SELECT s.id, s.barber_id, s.business_id, s.name, s.description, s.category, s.icon, s.image_url,
           s.price::float8 AS price, s.duration_minutes, s.is_active, s.created_at,
           b.name AS barber_name,
           biz.name AS shop_name
    FROM barber_services s
    LEFT JOIN barbers b ON b.id = s.barber_id
    LEFT JOIN businesses biz ON biz.id = s.business_id
  `;

  async function loadBarberBusinessId(bid) {
    const r = await dbQuery(`SELECT business_id FROM barbers WHERE id = $1 LIMIT 1`, [bid]);
    const biz = r.rows?.[0]?.business_id;
    return biz != null ? Number(biz) : null;
  }

  const servicesHandlers = [
    async (req, res, next) => {
      const hasAuth = !!(req.headers.authorization || req.headers.Authorization);
      if (hasAuth) return next();
      try {
        return await handlePublicBarberServicesGet(req, res, dbQuery);
      } catch (e) {
        console.error("[barber-business] public GET services:", e);
        return res.status(500).json({ error: "server_error", message: "Failed to load services" });
      }
    },
    ...chain,
    async (req, res) => {
      try {
        const includeInactive =
          String(req.query?.includeInactive || req.query?.all || "").toLowerCase() === "true" ||
          String(req.query?.includeInactive || req.query?.all || "") === "1";
        const where = includeInactive
          ? `WHERE s.barber_id = $1`
          : `WHERE s.barber_id = $1 AND s.is_active = true`;
        const r = await dbQuery(
          `${servicesSelectSql} ${where} ORDER BY s.is_active DESC, s.id ASC`,
          [req.barberId],
        );
        return res.json({ services: r.rows || [], barberId: req.barberId });
      } catch (e) {
        console.error("[barber-business] GET services:", e);
        return res.status(500).json({ error: "server_error", message: "Failed to load services" });
      }
    },
  ];

  router.get("/api/barber/services", ...servicesHandlers);
  router.get("/api/services", ...servicesHandlers);

  const postServiceHandler = async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name || name.length > 200) {
        return res.status(400).json({ error: "validation", message: "Service name is required" });
      }
      const price = money(req.body?.price ?? 0);
      const duration = Math.min(480, Math.max(5, num(req.body?.duration ?? req.body?.duration_minutes, 30)));
      const is_active = req.body?.is_active !== false && req.body?.isActive !== false;
      const description = String(req.body?.description || "").trim() || null;
      const category = String(req.body?.category || "").trim() || null;
      const icon = String(req.body?.icon || "").trim() || null;
      const image_url = String(req.body?.image_url || req.body?.imageUrl || "").trim() || null;
      const businessIdRaw = req.body?.business_id ?? req.body?.businessId;
      let business_id = businessIdRaw != null && String(businessIdRaw).trim() !== "" ? num(businessIdRaw, NaN) : null;
      if (!Number.isFinite(business_id)) {
        business_id = await loadBarberBusinessId(req.barberId);
      }

      const ins = await dbQuery(
        `INSERT INTO barber_services (barber_id, business_id, name, description, category, icon, image_url, price, duration_minutes, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, barber_id, business_id, name, description, category, icon, image_url, price::float8 AS price, duration_minutes, is_active, created_at`,
        [req.barberId, business_id, name, description, category, icon, image_url, price, duration, Boolean(is_active)],
      );
      const created = ins.rows?.[0];
      if (created) {
        await logServiceAudit({
          serviceId: created.id,
          barberId: created.barber_id,
          businessId: created.business_id,
          actor: actorFromReq(req),
          action: "created",
          newValue: {
            name: created.name,
            price: Number(created.price) || 0,
            duration_minutes: Number(created.duration_minutes) || 0,
            is_active: created.is_active !== false,
            category: created.category,
            image_url: created.image_url,
          },
        });
      }
      return res.status(201).json({ service: created });
    } catch (e) {
      console.error("[barber-business] POST services:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to create service" });
    }
  };
  router.post("/api/barber/services", ...chain, postServiceHandler);
  router.post("/api/services", ...chain, postServiceHandler);

  const putService = async (req, res) => {
    try {
      const id = num(req.params.id, NaN);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "validation", message: "Invalid id" });
      const name = String(req.body?.name ?? "").trim();
      const price = req.body?.price != null ? money(req.body.price) : null;
      const durationRaw = req.body?.duration ?? req.body?.duration_minutes;
      const duration = durationRaw != null ? Math.min(480, Math.max(5, num(durationRaw, 30))) : null;
      const is_active = req.body?.is_active ?? req.body?.isActive;
      const description =
        req.body?.description !== undefined ? String(req.body.description || "").trim() || null : undefined;
      const category =
        req.body?.category !== undefined ? String(req.body.category || "").trim() || null : undefined;
      const icon = req.body?.icon !== undefined ? String(req.body.icon || "").trim() || null : undefined;
      const image_url =
        req.body?.image_url !== undefined || req.body?.imageUrl !== undefined
          ? String(req.body?.image_url || req.body?.imageUrl || "").trim() || null
          : undefined;

      const cur = await dbQuery(
        `SELECT id, barber_id, business_id, name, description, category, icon, image_url,
                price::float8 AS price, duration_minutes, is_active
         FROM barber_services WHERE id = $1 AND barber_id = $2 LIMIT 1`,
        [id, req.barberId],
      );
      if (!cur.rows?.length) return res.status(404).json({ error: "not_found", message: "Service not found" });
      const oldRow = cur.rows[0];

      const r = await dbQuery(
        `UPDATE barber_services SET
           name = COALESCE(NULLIF($3::text, ''), name),
           description = CASE WHEN $11::boolean THEN description ELSE $7::text END,
           category = CASE WHEN $12::boolean THEN category ELSE $10::text END,
           icon = CASE WHEN $13::boolean THEN icon ELSE $8::text END,
           image_url = CASE WHEN $14::boolean THEN image_url ELSE $9::text END,
           price = COALESCE($4::numeric, price),
           duration_minutes = COALESCE($5::int, duration_minutes),
           is_active = CASE WHEN $6::boolean IS NULL THEN is_active ELSE $6::boolean END
         WHERE id = $1 AND barber_id = $2
         RETURNING id, barber_id, business_id, name, description, category, icon, image_url, price::float8 AS price, duration_minutes, is_active, created_at`,
        [
          id,
          req.barberId,
          name || null,
          price,
          duration,
          is_active == null ? null : Boolean(is_active),
          description === undefined ? null : description,
          icon === undefined ? null : icon,
          image_url === undefined ? null : image_url,
          category === undefined ? null : category,
          description === undefined,
          category === undefined,
          icon === undefined,
          image_url === undefined,
        ],
      );
      const newRow = r.rows?.[0];
      if (newRow) {
        await logServiceUpdateDiff({
          oldRow,
          newRow,
          actor: actorFromReq(req),
          metadata: { route: "PUT /api/barber/services/:id" },
        });
      }
      return res.json({ service: newRow });
    } catch (e) {
      console.error("[barber-business] PUT service:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to update service" });
    }
  };
  router.put("/api/barber/services/:id", ...chain, putService);
  router.put("/api/services/:id", ...chain, putService);

  const delService = async (req, res) => {
    try {
      const id = num(req.params.id, NaN);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "validation", message: "Invalid id" });
      const snapshot = await dbQuery(
        `SELECT id, barber_id, business_id, name, description, category, icon, image_url,
                price::float8 AS price, duration_minutes, is_active
         FROM barber_services WHERE id = $1 AND barber_id = $2 LIMIT 1`,
        [id, req.barberId],
      );
      const before = snapshot.rows?.[0] || null;
      const r = await dbQuery(`DELETE FROM barber_services WHERE id = $1 AND barber_id = $2 RETURNING id`, [
        id,
        req.barberId,
      ]);
      if (!r.rows?.length) return res.status(404).json({ error: "not_found", message: "Service not found" });
      if (before) {
        await logServiceAudit({
          serviceId: before.id,
          barberId: before.barber_id,
          businessId: before.business_id,
          actor: actorFromReq(req),
          action: "deleted",
          oldValue: {
            name: before.name,
            price: Number(before.price) || 0,
            duration_minutes: Number(before.duration_minutes) || 0,
            is_active: before.is_active !== false,
            category: before.category,
            image_url: before.image_url,
          },
          metadata: { route: "DELETE /api/barber/services/:id" },
        });
      }
      return res.json({ ok: true, id: r.rows[0].id });
    } catch (e) {
      console.error("[barber-business] DELETE service:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to delete service" });
    }
  };
  router.delete("/api/barber/services/:id", ...chain, delService);
  router.delete("/api/services/:id", ...chain, delService);

  // —— Availability / schedule ——
  async function loadSchedulePayload(bid) {
    const exists = await dbQuery(`SELECT id FROM barbers WHERE id::text = $1 LIMIT 1`, [String(bid)]);
    if (!exists.rows?.length) return null;
    const barberId = exists.rows[0].id;

    const avail = await dbQuery(
      `SELECT id, barber_id, day_of_week, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time, is_off
       FROM barber_availability WHERE barber_id = $1 ORDER BY day_of_week, start_time`,
      [barberId],
    );
    const breaks = await dbQuery(
      `SELECT id, day_of_week, to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
       FROM barber_availability_breaks WHERE barber_id = $1 ORDER BY day_of_week, start_time`,
      [barberId],
    );
    const blocked = await dbQuery(
      `SELECT id, to_char(blocked_date, 'YYYY-MM-DD') AS blocked_date, note
       FROM barber_blocked_dates WHERE barber_id = $1 ORDER BY blocked_date`,
      [barberId],
    );
    const settings = await dbQuery(
      `SELECT COALESCE(appointment_interval_minutes, 30) AS appointment_interval_minutes,
              COALESCE(NULLIF(trim(timezone), ''), 'America/New_York') AS timezone
       FROM barber_settings WHERE barber_id = $1 LIMIT 1`,
      [barberId],
    );
    const st = settings.rows?.[0] || {};
    const appointmentInterval = Number(st.appointment_interval_minutes) || 30;
    const timezone = String(st.timezone || "America/New_York");

    return {
      success: true,
      barberId,
      availability: avail.rows || [],
      breaks: breaks.rows || [],
      blockedDates: blocked.rows || [],
      appointmentInterval,
      timezone,
      appointment_interval_minutes: appointmentInterval,
    };
  }

  const getScheduleHandler = async (req, res) => {
    try {
      const payload = await loadSchedulePayload(req.barberId);
      if (!payload) {
        return res.status(404).json({
          success: false,
          error: "barber_not_found",
          message: "Barber not found.",
        });
      }
      return res.json(payload);
    } catch (e) {
      console.error("[barber-business] GET schedule:", e);
      return res.status(500).json({
        success: false,
        error: "server_error",
        message: "Failed to load schedule",
      });
    }
  };
  router.get("/api/barber/schedule", ...chain, getScheduleHandler);

  const getAvailabilityHandler = async (req, res) => getScheduleHandler(req, res);
  router.get("/api/barber/availability", ...chain, getAvailabilityHandler);
  router.get("/api/availability", ...chain, getAvailabilityHandler);

  const putScheduleHandler = async (req, res) => {
    try {
      const bid = req.barberId;
      const slots = Array.isArray(req.body?.availability) ? req.body.availability : req.body?.slots;
      if (!Array.isArray(slots)) {
        return res.status(400).json({ error: "validation", message: "Body must include availability: []" });
      }

      const breaks = Array.isArray(req.body?.breaks) ? req.body.breaks : null;
      const blockedDates = Array.isArray(req.body?.blockedDates) ? req.body.blockedDates : null;
      const intervalRaw =
        req.body?.appointment_interval_minutes ??
        req.body?.appointmentIntervalMinutes ??
        req.body?.appointmentInterval;
      const timezoneRaw = String(req.body?.timezone ?? "").trim();

      await dbQuery(`DELETE FROM barber_availability WHERE barber_id = $1`, [bid]);

      for (const row of slots) {
        const dow = num(row.day_of_week ?? row.dayOfWeek, NaN);
        const start = String(row.start_time ?? row.startTime ?? "").trim();
        const end = String(row.end_time ?? row.endTime ?? "").trim();
        const is_off = Boolean(row.is_off ?? row.isOff);
        if (!Number.isFinite(dow) || dow < 0 || dow > 6) {
          return res.status(400).json({ error: "validation", message: "day_of_week must be 0–6" });
        }
        if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
          return res.status(400).json({ error: "validation", message: "start_time and end_time must be HH:MM" });
        }
        await dbQuery(
          `INSERT INTO barber_availability (barber_id, day_of_week, start_time, end_time, is_off)
           VALUES ($1, $2, $3::time, $4::time, $5)`,
          [bid, dow, start, end, is_off],
        );
      }

      if (breaks !== null) {
        await dbQuery(`DELETE FROM barber_availability_breaks WHERE barber_id = $1`, [bid]);
        for (const row of breaks) {
          const dow = num(row.day_of_week ?? row.dayOfWeek, NaN);
          const start = String(row.start_time ?? row.startTime ?? "").trim();
          const end = String(row.end_time ?? row.endTime ?? "").trim();
          if (!Number.isFinite(dow) || dow < 0 || dow > 6) {
            return res.status(400).json({ error: "validation", message: "break day_of_week must be 0–6" });
          }
          if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
            return res.status(400).json({ error: "validation", message: "break times must be HH:MM" });
          }
          await dbQuery(
            `INSERT INTO barber_availability_breaks (barber_id, day_of_week, start_time, end_time)
             VALUES ($1, $2, $3::time, $4::time)`,
            [bid, dow, start, end],
          );
        }
      }

      if (blockedDates !== null) {
        await dbQuery(`DELETE FROM barber_blocked_dates WHERE barber_id = $1`, [bid]);
        for (const row of blockedDates) {
          const dateStr =
            typeof row === "string"
              ? row.trim()
              : String(row?.blocked_date ?? row?.blockedDate ?? "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
          const note = typeof row === "object" ? String(row?.note ?? "").trim() : "";
          await dbQuery(
            `INSERT INTO barber_blocked_dates (barber_id, blocked_date, note) VALUES ($1, $2::date, $3)
             ON CONFLICT (barber_id, blocked_date) DO UPDATE SET note = EXCLUDED.note`,
            [bid, dateStr, note || null],
          );
        }
      }

      if (intervalRaw != null || timezoneRaw) {
        await dbQuery(
          `INSERT INTO barber_settings (barber_id) VALUES ($1) ON CONFLICT (barber_id) DO NOTHING`,
          [bid],
        );
        const interval = intervalRaw != null ? Math.max(5, Math.min(120, num(intervalRaw, 30))) : null;
        if (interval != null && timezoneRaw) {
          await dbQuery(
            `UPDATE barber_settings SET appointment_interval_minutes = $2, timezone = $3 WHERE barber_id = $1`,
            [bid, interval, timezoneRaw],
          );
        } else if (interval != null) {
          await dbQuery(
            `UPDATE barber_settings SET appointment_interval_minutes = $2 WHERE barber_id = $1`,
            [bid, interval],
          );
        } else if (timezoneRaw) {
          await dbQuery(`UPDATE barber_settings SET timezone = $2 WHERE barber_id = $1`, [bid, timezoneRaw]);
        }
      }

      return getScheduleHandler(req, res);
    } catch (e) {
      console.error("[barber-business] PUT schedule:", e);
      return res.status(500).json({
        success: false,
        error: "server_error",
        message: "Failed to save schedule",
      });
    }
  };
  router.put("/api/barber/schedule", ...chain, putScheduleHandler);

  const putAvailabilityHandler = async (req, res) => putScheduleHandler(req, res);
  router.put("/api/barber/availability", ...chain, putAvailabilityHandler);
  router.put("/api/availability", ...chain, putAvailabilityHandler);

  // —— Settings ——
  const getSettingsHandler = async (req, res) => {
    try {
      await dbQuery(
        `INSERT INTO barber_settings (barber_id) VALUES ($1) ON CONFLICT (barber_id) DO NOTHING`,
        [req.barberId],
      );
      const st = await loadBarberSettingsRow(req.barberId);
      return res.json({ settings: { barber_id: req.barberId, ...st } });
    } catch (e) {
      console.error("[barber-business] GET settings:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to load settings" });
    }
  };
  router.get("/api/barber/settings", ...chain, getSettingsHandler);
  router.get("/api/settings", ...chain, getSettingsHandler);

  const putSettingsHandler = async (req, res) => {
    try {
      const bid = req.barberId;
      await dbQuery(
        `INSERT INTO barber_settings (barber_id) VALUES ($1) ON CONFLICT (barber_id) DO NOTHING`,
        [bid],
      );

      const existing = await loadBarberSettingsRow(bid);

      const theme_color = String(req.body?.theme_color ?? req.body?.themeColor ?? "").trim();
      const booking_deposit_enabled = req.body?.booking_deposit_enabled ?? req.body?.bookingDepositEnabled;
      const deposit_amount = req.body?.deposit_amount ?? req.body?.depositAmount;
      const payment_method = String(req.body?.payment_method ?? req.body?.paymentMethod ?? "").trim();
      const aura_enabled = req.body?.aura_enabled ?? req.body?.auraEnabled;
      const aura_voice_type = String(req.body?.aura_voice_type ?? req.body?.auraVoiceType ?? "").trim();
      const language = String(req.body?.language ?? "").trim();

      const tierRaw = req.body?.subscription_tier ?? req.body?.subscriptionTier;
      const tierUpdate =
        tierRaw != null && String(tierRaw).trim() !== "" ? normalizeTier(String(tierRaw)) : null;
      const nextTier = tierUpdate ?? existing.subscription_tier;

      const subPriceRaw = req.body?.subscription_monthly_price ?? req.body?.subscriptionMonthlyPrice;
      let priceSqlToken = "noop";
      if (subPriceRaw === "" || tierUpdate === TIER_FREE) priceSqlToken = "clear";
      else if (subPriceRaw != null && String(subPriceRaw).trim() !== "") priceSqlToken = String(money(subPriceRaw));

      let nextMonthlyPrice = existing.subscription_monthly_price;
      if (priceSqlToken === "clear") nextMonthlyPrice = null;
      else if (priceSqlToken !== "noop") nextMonthlyPrice = money(priceSqlToken);
      if (normalizeTier(nextTier) === TIER_FREE) nextMonthlyPrice = null;

      const v = validateSubscriptionMonthlyPrice(nextTier, nextMonthlyPrice);
      if (!v.ok) {
        return res.status(400).json({ error: "validation", message: v.message || "Invalid subscription price" });
      }

      const billingProvRaw = req.body?.billing_provider ?? req.body?.billingProvider;
      const billingSubIdRaw = req.body?.billing_subscription_id ?? req.body?.billingSubscriptionId;
      let billingSubSql = "noop";
      if (billingSubIdRaw === "") billingSubSql = "clear";
      else if (billingSubIdRaw != null) billingSubSql = String(billingSubIdRaw).trim() || "clear";

      const r = await dbQuery(
        `UPDATE barber_settings SET
           theme_color = CASE WHEN $2::text IS NULL OR $2::text = '' THEN theme_color ELSE $2::text END,
           booking_deposit_enabled = CASE WHEN $3::boolean IS NULL THEN booking_deposit_enabled ELSE $3::boolean END,
           deposit_amount = CASE WHEN $4::numeric IS NULL THEN deposit_amount ELSE $4::numeric END,
           payment_method = CASE WHEN $5::text IS NULL OR $5::text = '' THEN payment_method ELSE $5::text END,
           aura_enabled = CASE WHEN $6::boolean IS NULL THEN aura_enabled ELSE $6::boolean END,
           aura_voice_type = CASE WHEN $7::text IS NULL OR $7::text = '' THEN aura_voice_type ELSE $7::text END,
           language = CASE WHEN $8::text IS NULL OR $8::text = '' THEN language ELSE $8::text END,
           subscription_tier = CASE WHEN $9::text IS NULL OR $9::text = '' THEN subscription_tier ELSE $9::text END,
           subscription_monthly_price = CASE
             WHEN $10::text = 'noop' THEN subscription_monthly_price
             WHEN $10::text = 'clear' THEN NULL
             ELSE $10::numeric
           END,
           billing_provider = CASE WHEN $11::text IS NULL OR $11::text = '' THEN billing_provider ELSE $11::text END,
           billing_subscription_id = CASE
             WHEN $12::text = 'noop' THEN billing_subscription_id
             WHEN $12::text = 'clear' THEN NULL
             ELSE $12::text
           END
         WHERE barber_id = $1`,
        [
          bid,
          theme_color || null,
          booking_deposit_enabled == null ? null : Boolean(booking_deposit_enabled),
          deposit_amount != null ? money(deposit_amount) : null,
          payment_method || null,
          aura_enabled == null ? null : Boolean(aura_enabled),
          aura_voice_type || null,
          language || null,
          tierUpdate || null,
          priceSqlToken,
          billingProvRaw != null && String(billingProvRaw).trim() !== ""
            ? normalizeBillingProvider(billingProvRaw)
            : null,
          billingSubSql,
        ],
      );
      if (!r.rowCount) {
        return res.status(404).json({ error: "not_found", message: "Barber settings not found" });
      }
      const st = await loadBarberSettingsRow(bid);
      return res.json({ settings: { barber_id: bid, ...st } });
    } catch (e) {
      console.error("[barber-business] PUT settings:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to save settings" });
    }
  };
  router.put("/api/barber/settings", ...chain, putSettingsHandler);
  router.put("/api/settings", ...chain, putSettingsHandler);

  // —— Clients ——
  const getClientsHandler = async (req, res) => {
    try {
      const r = await dbQuery(
        `SELECT id, barber_id, name, email, phone, notes, created_at FROM barber_clients WHERE barber_id = $1 ORDER BY created_at DESC LIMIT 500`,
        [req.barberId],
      );
      return res.json({ clients: r.rows || [] });
    } catch (e) {
      console.error("[barber-business] GET clients:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to load clients" });
    }
  };
  router.get("/api/barber/clients", ...chain, getClientsHandler);
  router.get("/api/clients", ...chain, getClientsHandler);

  const postClientsHandler = async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name || name.length > 200) {
        return res.status(400).json({ error: "validation", message: "Client name is required" });
      }
      const email = String(req.body?.email ?? "").trim() || null;
      const phone = String(req.body?.phone ?? "").trim() || null;
      const notes = String(req.body?.notes ?? "").trim() || null;
      if (notes && notes.length > 4000) {
        return res.status(400).json({ error: "validation", message: "Notes too long" });
      }

      const ins = await dbQuery(
        `INSERT INTO barber_clients (barber_id, name, email, phone, notes) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, barber_id, name, email, phone, notes, created_at`,
        [req.barberId, name, email, phone, notes],
      );
      return res.status(201).json({ client: ins.rows?.[0] });
    } catch (e) {
      console.error("[barber-business] POST clients:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to create client" });
    }
  };
  router.post("/api/barber/clients", ...chain, postClientsHandler);
  router.post("/api/clients", ...chain, postClientsHandler);

  // —— Portfolio media ——
  router.get("/api/barber/media", ...chain, async (req, res) => {
    try {
      const r = await dbQuery(
        `SELECT id, barber_id, image_url, caption, sort_order, created_at
         FROM barber_portfolio_images WHERE barber_id = $1 ORDER BY sort_order ASC, id ASC`,
        [req.barberId],
      );
      return res.json({ media: r.rows || [] });
    } catch (e) {
      console.error("[barber-business] GET media:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to load media" });
    }
  });

  router.post("/api/barber/media", ...chain, uploadMemory.single("image"), async (req, res) => {
    try {
      const caption = String(req.body?.caption ?? "").trim().slice(0, 500) || null;
      const sort_order = num(req.body?.sort_order ?? req.body?.sortOrder, 0);
      let url = String(req.body?.image_url ?? req.body?.imageUrl ?? "").trim();
      if (req.file?.buffer?.length) {
        const br = await dbQuery(`SELECT name FROM barbers WHERE id::text = $1::text LIMIT 1`, [String(req.barberId)]);
        const barberName = br.rows?.[0]?.name || `barber-${req.barberId}`;
        const uploaded = await uploadBarberStyleImage({
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          barberName,
          originalName: req.file.originalname || "portfolio.jpg",
        });
        url = uploaded.url;
      }
      if (!url) return res.status(400).json({ error: "validation", message: "Image file or image_url required" });

      const ins = await dbQuery(
        `INSERT INTO barber_portfolio_images (barber_id, image_url, caption, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, barber_id, image_url, caption, sort_order, created_at`,
        [req.barberId, url, caption, sort_order],
      );
      return res.status(201).json({ item: ins.rows?.[0] });
    } catch (e) {
      console.error("[barber-business] POST media:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to save media" });
    }
  });

  router.delete("/api/barber/media/:id", ...chain, async (req, res) => {
    try {
      const id = num(req.params.id, NaN);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "validation", message: "Invalid id" });
      const r = await dbQuery(`DELETE FROM barber_portfolio_images WHERE id = $1 AND barber_id = $2 RETURNING id`, [
        id,
        req.barberId,
      ]);
      if (!r.rows?.length) return res.status(404).json({ error: "not_found", message: "Media not found" });
      void writeSecurityAudit({
        eventType: "media_deleted",
        actorUserId: req.user?.id ? String(req.user.id) : null,
        actorEmail: req.user?.email || null,
        req,
        metadata: { mediaId: id, barberId: req.barberId, action: "media_deleted" },
      });
      return res.json({ ok: true, id: r.rows[0].id });
    } catch (e) {
      console.error("[barber-business] DELETE media:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to delete media" });
    }
  });

  /** Ledger rows: mandatory per-booking platform fee (barber accrual). */
  router.get("/api/barber/fees/:barberId", requireAuth, async (req, res) => {
    try {
      const resolved = await resolveScopedBarberId(req.user, req.params.barberId);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error, message: resolved.message });
      }
      const bid = resolved.barberId;
      const r = await dbQuery(
        `SELECT id, barber_id, booking_id, fee_amount::float8 AS fee_amount, fee_status, billed_at, paid_at, created_at
         FROM barber_fee_ledger
         WHERE barber_id = $1
         ORDER BY id DESC
         LIMIT 500`,
        [bid],
      );
      return res.json({ ok: true, fees: r.rows || [] });
    } catch (e) {
      console.error("[barber-business] GET fees:", e);
      return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
    }
  });

  /** Aggregates for barber dashboard (fees are internal; not shown to end customers on public booking). */
  router.get("/api/barber/billing-summary/:barberId", requireAuth, async (req, res) => {
    try {
      const resolved = await resolveScopedBarberId(req.user, req.params.barberId);
      if (resolved.error) {
        return res.status(resolved.status).json({ error: resolved.error, message: resolved.message });
      }
      const bid = resolved.barberId;
      const [cnt, svc, acc, st] = await Promise.all([
        dbQuery(`SELECT COUNT(*)::int AS n FROM bookings WHERE barber_id = $1`, [bid]),
        dbQuery(`SELECT COALESCE(SUM(total_price), 0)::float8 AS s FROM bookings WHERE barber_id = $1`, [bid]),
        dbQuery(
          `SELECT COALESCE(SUM(fee_amount), 0)::float8 AS s FROM barber_fee_ledger WHERE barber_id = $1 AND fee_status IN ('accrued','pending')`,
          [bid],
        ),
        loadBarberSettingsRow(bid),
      ]);
      const totalBookings = Number(cnt.rows?.[0]?.n) || 0;
      const serviceTotalUsd = money(Number(svc.rows?.[0]?.s) || 0);
      const accruedPlatformFeesUsd = money(Number(acc.rows?.[0]?.s) || 0);
      const platformFeeUsd = 0.99;
      const netBarberEstimateUsd = money(Math.max(0, serviceTotalUsd - accruedPlatformFeesUsd));
      return res.json({
        ok: true,
        barberId: bid,
        totalBookings,
        serviceTotalUsd,
        platformFeeUsd,
        accruedPlatformFeesUsd,
        netBarberEarningsEstimateUsd: netBarberEstimateUsd,
        isPro: Boolean(st?.is_pro),
        proPurchaseStatus: String(st?.pro_purchase_status || "not_purchased"),
        proPurchasedAt: st?.pro_purchased_at || null,
        exampleForServiceUsd30: {
          serviceTotal: 30,
          platformFee: platformFeeUsd,
          netBarberEarnings: money(30 - platformFeeUsd),
        },
      });
    } catch (e) {
      console.error("[barber-business] GET billing-summary:", e);
      return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
    }
  });

  // —— Staff: list barbers for schedule picker (scoped by role) ——
  router.get("/api/barber/list", requireAuth, async (req, res) => {
    const role = String(req.user?.role || "");
    const isGlobalAdmin =
      role === "super_admin" ||
      role === "admin" ||
      req.user?.isSuperAdmin === true ||
      req.user?.isOwner === true;
    try {
      if (isGlobalAdmin) {
        const r = await dbQuery(
          `SELECT id, name, phone, user_id FROM barbers ORDER BY name ASC NULLS LAST LIMIT 500`,
        );
        return res.json({ barbers: r.rows || [] });
      }
      if (role === "shop_owner") {
        const shop = await dbQuery(
          `SELECT business_id FROM app_users WHERE id = $1::uuid AND role = 'shop_owner' LIMIT 1`,
          [String(req.user.id)],
        );
        const bizId = shop.rows?.[0]?.business_id;
        if (bizId == null) {
          return res.status(403).json({
            error: "forbidden",
            message: "Shop owner account is not linked to a business.",
          });
        }
        const r = await dbQuery(
          `SELECT id, name, phone, user_id FROM barbers WHERE business_id = $1 ORDER BY name ASC NULLS LAST LIMIT 500`,
          [Number(bizId)],
        );
        return res.json({ barbers: r.rows || [] });
      }
      if (role === "barber") {
        const scoped = await resolveScopedBarberId(req.user, null);
        if (scoped.error) {
          return res.status(scoped.status).json({ error: scoped.error, message: scoped.message });
        }
        const r = await dbQuery(
          `SELECT id, name, phone, user_id FROM barbers WHERE id::text = $1 LIMIT 1`,
          [String(scoped.barberId)],
        );
        return res.json({ barbers: r.rows || [] });
      }
      return res.status(403).json({ error: "forbidden", message: "Staff access only" });
    } catch (e) {
      console.error("[barber-business] list:", e);
      return res.status(500).json({ error: "server_error", message: "Failed to list barbers" });
    }
  });

  // —— Shop / business roster (admins + shop owners) ——
  router.get("/api/shop/list", requireAuth, async (req, res) => {
    if (!canManageShopsRole(req.user)) {
      return res.status(403).json({
        success: false,
        error: "forbidden",
        message: "Shop management is for admins and shop owners.",
      });
    }
    try {
      if (isJwtGlobalSuperScope(req.user) || String(req.user?.role || "").trim().toLowerCase() === "admin") {
        const shops = await queryShopRows();
        return res.json({ success: true, shops });
      }
      const scope = await getBusinessScopeForUser(req.user);
      if (scope.businessId == null) {
        return res.status(403).json({
          success: false,
          error: "forbidden",
          message: "Shop owner account is not linked to a business.",
        });
      }
      const shops = await queryShopRows("WHERE b.id = $1::bigint", [Number(scope.businessId)]);
      return res.json({ success: true, shops });
    } catch (e) {
      console.error("[barber-business] shop list:", e);
      return res.status(500).json({ success: false, error: "server_error", message: "Failed to list shops" });
    }
  });

  router.get("/api/shop/detail", requireAuth, async (req, res) => {
    try {
      const idRaw = extractBusinessIdFromRequest(req);
      if (String(idRaw).startsWith("placeholder-")) {
        return res.status(400).json({
          success: false,
          error: "invalid_id",
          message: "Preview shop ids are not stored on the server.",
        });
      }
      const access = await assertShopAccess(req.user, idRaw);
      if (access.error) {
        return res.status(access.status).json({ success: false, error: access.error, message: access.message });
      }
      const shops = await queryShopRows("WHERE b.id = $1::bigint", [Number(access.businessId)]);
      const shop = shops[0];
      if (!shop) {
        return res.status(404).json({ success: false, error: "not_found", message: "Shop not found." });
      }
      return res.json({ success: true, shop });
    } catch (e) {
      console.error("[barber-business] shop detail:", e);
      return res.status(500).json({ success: false, error: "server_error", message: "Failed to load shop" });
    }
  });

  router.put("/api/shop/detail", requireAuth, async (req, res) => {
    try {
      const idRaw = extractBusinessIdFromRequest(req);
      if (String(idRaw).startsWith("placeholder-")) {
        return res.status(400).json({
          success: false,
          error: "invalid_id",
          message: "Preview shop ids are not stored on the server.",
        });
      }
      const access = await assertShopAccess(req.user, idRaw);
      if (access.error) {
        return res.status(access.status).json({ success: false, error: access.error, message: access.message });
      }
      const name = String(req.body?.name ?? "").trim();
      const phone = String(req.body?.phone ?? "").trim() || null;
      if (name && name.length > 200) {
        return res.status(400).json({ success: false, error: "validation", message: "Name too long" });
      }
      const r = await dbQuery(
        `UPDATE businesses SET
           name = COALESCE(NULLIF($2::text, ''), name),
           phone = COALESCE($3::text, phone)
         WHERE id = $1::bigint
         RETURNING id AS business_id, name, phone, plan, subscription_status AS status`,
        [Number(access.businessId), name || null, phone],
      );
      const row = r.rows?.[0];
      if (!row) {
        return res.status(404).json({ success: false, error: "not_found", message: "Shop not found." });
      }
      return res.json({ success: true, shop: row });
    } catch (e) {
      console.error("[barber-business] shop update:", e);
      return res.status(500).json({ success: false, error: "server_error", message: "Failed to update shop" });
    }
  });

  return router;
}
