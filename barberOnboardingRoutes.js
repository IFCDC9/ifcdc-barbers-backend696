/**
 * Premium barber onboarding API.
 * - POST /api/barber/onboard — register barber account + barber row + settings (public)
 * - POST /api/barber/onboard/services — bulk create services (auth, barber role)
 * - POST /api/barber/onboard/complete — create default bookable style if none (auth)
 * - POST /api/barber/onboard/branding — multipart branding upload (auth); field `file` + `slot` = logo | profile
 *
 * Single-service POST /api/barber/services remains on the barber business router (unchanged).
 */
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dbQuery } from "./db.js";
import { comparePassword, hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";
import { normalizeEmail } from "./authStore.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import { issueAppUserJwt, requireAuth } from "./authRoutes.js";
import { resolveScopedBarberId } from "./barberScope.js";
import { ensureStylesTables } from "./stylesMigrations.js";
import { notifySuperAdminsNewBarber, persistBusinessLocation } from "./adminBarberService.js";
import { notifySuperAdminsNewShop } from "./adminShopsService.js";

const DEFAULT_STYLE_IMAGE =
  "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=1200&q=70";

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildLocationPayload(address, latitude, longitude) {
  const addr = String(address || "").trim();
  const lat = latitude === "" || latitude == null ? null : Number(latitude);
  const lng = longitude === "" || longitude == null ? null : Number(longitude);
  return JSON.stringify({
    address: addr,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
  });
}

async function barberScopeMiddleware(req, res, next) {
  try {
    const resolved = await resolveScopedBarberId(req.user, req.query?.barberId ?? req.body?.barber_id);
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error, message: resolved.message });
    }
    req.barberId = resolved.barberId;
    return next();
  } catch (e) {
    console.error("[barber-onboard] scope:", e);
    return res.status(500).json({ error: "scope_failed", message: e?.message || String(e) });
  }
}

const brandingImageMime = /^image\/(jpeg|pjpeg|png|gif|webp|avif)$/i;

export function mountBarberOnboardingRoutes(app, { uploadDir } = {}) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const baseDir = uploadDir || path.join(__dirname, "backend", "uploads");
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const uploadBranding = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, baseDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "").slice(0, 12).toLowerCase();
        const safe =
          ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".gif" || ext === ".webp" || ext === ".avif"
            ? ext
            : ".jpg";
        cb(null, `onboard-${Date.now()}-${Math.random().toString(16).slice(2)}${safe}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype || !brandingImageMime.test(file.mimetype)) {
        return cb(new Error("Only JPEG, PNG, GIF, WebP, or AVIF images are allowed"));
      }
      cb(null, true);
    },
  });

  function handleBrandingUpload(req, res, next) {
    uploadBranding.single("file")(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "file_too_large", message: "Image must be 5MB or smaller" });
      }
      return res.status(400).json({ error: "invalid_file", message: err.message || "Upload failed" });
    });
  }

  app.post("/api/barber/onboard", express.json({ limit: "64kb" }), async (req, res) => {
    try {
      const ownerName = String(req.body?.name || req.body?.ownerName || "").trim();
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const displayName = String(req.body?.displayName || req.body?.barberName || ownerName || "Barber").trim();
      const shopName = String(req.body?.shopName || req.body?.shop_name || "").trim() || null;
      const phone = String(req.body?.phone || "").trim() || null;
      const bio = String(req.body?.bio || "").trim() || "";
      const address = String(req.body?.address || "").trim();
      const latitude = req.body?.latitude;
      const longitude = req.body?.longitude;

      if (!ownerName) return res.status(400).json({ ok: false, error: "name_required", message: "Name is required" });
      if (!email) return res.status(400).json({ ok: false, error: "email_required", message: "Email is required" });
      const pw = validatePasswordStrength(password);
      if (!pw.valid) return res.status(400).json({ ok: false, error: "weak_password", message: pw.message });

      const locationJson = address || latitude != null || longitude != null ? buildLocationPayload(address, latitude, longitude) : null;

      const businessLabel = (shopName || `${displayName} Shop`).trim() || "IFCDC Shop";
      const bizIns = await dbQuery(
        `INSERT INTO businesses (
           name, phone, plan, subscription_status, account_status, approval_status, access_plan,
           free_access_enabled, paid_subscription_required, bookings_enabled, payment_processing_enabled
         )
         VALUES ($1, $2, 'free', 'inactive', 'pending', 'pending', 'pending', false, true, false, false)
         RETURNING id`,
        [businessLabel, phone],
      );
      const businessNumericId = bizIns.rows?.[0]?.id;
      if (businessNumericId == null) throw new Error("business_insert_failed");

      const found = await dbQuery(
        `SELECT id, name, email, password_hash, role, barber_id, business_id
         FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
        [email],
      );
      const existingRow = found.rows?.[0];
      let existingAccount = false;
      let user;

      if (existingRow?.id) {
        const pwdOk = await comparePassword(password, existingRow.password_hash);
        if (!pwdOk) {
          await dbQuery(`DELETE FROM businesses WHERE id = $1`, [businessNumericId]);
          return res.status(401).json({
            ok: false,
            error: "invalid_credentials",
            loginRequired: true,
            message:
              "This email is already registered. Sign in with the correct password, or use Forgot password on the login page.",
          });
        }
        existingAccount = true;
        const acctName = ownerName || String(existingRow.name || "").trim() || "Barber";
        const role = String(existingRow.role || "").toLowerCase();
        const promoteBarber =
          role !== "barber" && role !== "admin" && role !== "super_admin" && role !== "shop_owner";
        await dbQuery(
          `UPDATE app_users SET name = $1::text, phone = COALESCE($4, phone),
                  role = CASE WHEN $3::boolean THEN 'barber' ELSE role END,
                  account_status = CASE WHEN $3::boolean THEN 'pending' ELSE account_status END
           WHERE id = $2::uuid`,
          [acctName, existingRow.id, promoteBarber, phone],
        );
        const refreshed = await dbQuery(
          `SELECT id, name, email, role, barber_id, business_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
          [existingRow.id],
        );
        user = refreshed.rows?.[0];
        if (!user?.id) throw new Error("user_reload_failed");
      } else {
        const passwordHash = await hashPassword(password);
        const userIns = await dbQuery(
          `INSERT INTO app_users (name, email, password_hash, role, business_id, phone, account_status)
           VALUES ($1, $2, $3, 'barber', $4, $5, 'pending')
           RETURNING id, name, email, role, business_id`,
          [ownerName, email, passwordHash, businessNumericId, phone],
        );
        user = userIns.rows?.[0];
        if (!user?.id) throw new Error("user_insert_failed");
      }

      let barberId = user.barber_id != null ? Number(user.barber_id) : null;

      if (!Number.isFinite(barberId)) {
        const barberIns = await dbQuery(
          `INSERT INTO barbers (name, shop_name, business_id, user_id, phone, bio, location, verification_status)
           VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, 'pending')
           RETURNING id`,
          [displayName, shopName, businessNumericId, user.id, phone, bio || null, locationJson],
        );
        barberId = barberIns.rows?.[0]?.id;
        if (barberId == null) throw new Error("barber_insert_failed");
      } else {
        const upd = await dbQuery(
          `UPDATE barbers SET business_id = $1, name = $2, shop_name = $3, phone = $4, bio = $5, location = $6
           WHERE id = $7 AND user_id = $8::uuid
           RETURNING id`,
          [businessNumericId, displayName, shopName, phone, bio || null, locationJson, barberId, user.id],
        );
        if (!upd.rows?.length) {
          const barberIns = await dbQuery(
            `INSERT INTO barbers (name, shop_name, business_id, user_id, phone, bio, location, verification_status)
             VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, 'pending')
             RETURNING id`,
            [displayName, shopName, businessNumericId, user.id, phone, bio || null, locationJson],
          );
          barberId = barberIns.rows?.[0]?.id;
          if (barberId == null) throw new Error("barber_insert_failed");
        }
      }

      await dbQuery(`UPDATE app_users SET barber_id = $1, business_id = $2, account_status = 'pending' WHERE id = $3::uuid`, [
        barberId,
        businessNumericId,
        user.id,
      ]);

      await dbQuery(
        `INSERT INTO barber_settings (barber_id, subscription_tier, aura_enabled, payment_method)
         VALUES ($1, 'pro', true, 'paypal')
         ON CONFLICT (barber_id) DO NOTHING`,
        [barberId],
      );

      if (isSuperAdminEmail(email)) {
        await dbQuery(`UPDATE app_users SET role = 'super_admin' WHERE id = $1::uuid`, [user.id]);
      } else {
        const loc = await persistBusinessLocation(businessNumericId, address, null, null);
        void notifySuperAdminsNewBarber({
          barberId,
          fullName: displayName || ownerName,
          shopName: shopName || businessLabel,
          city: loc.city,
          state: loc.state,
          email,
        });
        void notifySuperAdminsNewShop({
          businessId: businessNumericId,
          shopName: shopName || businessLabel,
          ownerName: displayName || ownerName,
          city: loc.city,
          state: loc.state,
          email,
        });
      }

      const uFinal = await dbQuery(
        `SELECT id, name, email, role, barber_id, business_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [user.id],
      );
      const u = uFinal.rows?.[0] || user;

      const token = issueAppUserJwt(u);
      const httpStatus = existingAccount ? 200 : 201;
      return res.status(httpStatus).json({
        ok: true,
        existing: existingAccount,
        token,
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          business_id: businessNumericId,
          barber_id: barberId,
        },
        barber: { id: barberId, name: displayName, shop_name: shopName },
      });
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("duplicate") || e?.code === "23505") {
        return res.status(409).json({ ok: false, error: "email_exists", message: "Email already registered." });
      }
      console.error("[barber/onboard]", e?.stack || e);
      return res.status(500).json({ ok: false, error: "onboard_failed", message: e?.message || String(e) });
    }
  });

  app.post(
    "/api/barber/onboard/services",
    requireAuth,
    barberScopeMiddleware,
    express.json({ limit: "256kb" }),
    async (req, res) => {
      try {
        const role = String(req.user?.role || "").toLowerCase();
        if (role !== "barber" && role !== "admin" && role !== "super_admin") {
          return res.status(403).json({ error: "forbidden", message: "Barber or admin only" });
        }
        const list = Array.isArray(req.body?.services) ? req.body.services : null;
        if (!list || !list.length) {
          return res.status(400).json({ error: "validation", message: "Body must include services: [{ name, price }]" });
        }
        await dbQuery(`ALTER TABLE barber_services ADD COLUMN IF NOT EXISTS business_id BIGINT;`);

        await dbQuery(`DELETE FROM barber_services WHERE barber_id = $1`, [req.barberId]);

        const bRow = await dbQuery(`SELECT business_id FROM barbers WHERE id = $1 LIMIT 1`, [req.barberId]);
        const shopBusinessId = bRow.rows?.[0]?.business_id;

        const created = [];
        for (const row of list) {
          const name = String(row?.name || "").trim();
          if (!name || name.length > 200) continue;
          const price = money(row?.price ?? 0);
          const duration = Math.min(480, Math.max(5, num(row?.duration_minutes ?? row?.duration ?? 30, 30)));
          const is_active = row?.is_active !== false && row?.isActive !== false;
          const ins = shopBusinessId != null
            ? await dbQuery(
                `INSERT INTO barber_services (barber_id, business_id, name, price, duration_minutes, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, barber_id, name, price::float8 AS price, duration_minutes, is_active, created_at`,
                [req.barberId, shopBusinessId, name, price, duration, Boolean(is_active)],
              )
            : await dbQuery(
                `INSERT INTO barber_services (barber_id, name, price, duration_minutes, is_active)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, barber_id, name, price::float8 AS price, duration_minutes, is_active, created_at`,
                [req.barberId, name, price, duration, Boolean(is_active)],
              );
          if (ins.rows?.[0]) created.push(ins.rows[0]);
        }
        if (!created.length) {
          return res.status(400).json({ error: "validation", message: "No valid services to create" });
        }
        return res.status(201).json({ ok: true, services: created });
      } catch (e) {
        console.error("[barber/onboard/services]", e);
        return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
      }
    },
  );

  app.post("/api/barber/onboard/complete", requireAuth, barberScopeMiddleware, async (req, res) => {
    try {
      const bid = req.barberId;
      await ensureStylesTables();
      const existing = await dbQuery(`SELECT COUNT(*)::int AS n FROM styles WHERE barber_id = $1`, [bid]);
      const n = existing.rows?.[0]?.n ?? 0;
      if (n > 0) {
        return res.json({ ok: true, alreadyComplete: true, message: "Styles already exist for this barber." });
      }
      const svc = await dbQuery(
        `SELECT id, name, price::float8 AS price FROM barber_services WHERE barber_id = $1 AND is_active = true ORDER BY id ASC LIMIT 1`,
        [bid],
      );
      const srow = svc.rows?.[0];
      const title = srow?.name ? String(srow.name) : "Signature cut";
      const price = money(srow?.price ?? 35);

      const prof = await dbQuery(`SELECT profile_image, logo FROM barbers WHERE id = $1 LIMIT 1`, [bid]);
      const img =
        String(prof.rows?.[0]?.profile_image || "").trim() ||
        String(prof.rows?.[0]?.logo || "").trim() ||
        DEFAULT_STYLE_IMAGE;

      const ins = await dbQuery(
        `INSERT INTO styles (barber_id, title, description, image_url, category, price)
         VALUES ($1, $2, $3, $4, 'other', $5)
         RETURNING id, title, price::float8 AS price`,
        [bid, title, "Book on IFCDC — full payment at checkout.", img, price],
      );
      return res.status(201).json({ ok: true, style: ins.rows?.[0] || null });
    } catch (e) {
      console.error("[barber/onboard/complete]", e);
      return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
    }
  });

  app.post("/api/barber/onboard/branding", requireAuth, barberScopeMiddleware, handleBrandingUpload, async (req, res) => {
    try {
      if (!req.file?.filename) {
        return res.status(400).json({ error: "file_required", message: "Multipart field `file` (image) is required" });
      }
      const slot = String(req.body?.slot || req.query?.slot || "profile").toLowerCase();
      const url = `/uploads/${req.file.filename}`;
      const bid = req.barberId;

      if (slot === "logo") {
        await dbQuery(`UPDATE barbers SET logo = $1 WHERE id = $2`, [url, bid]);
      } else {
        await dbQuery(`UPDATE barbers SET profile_image = $1 WHERE id = $2`, [url, bid]);
      }
      return res.status(201).json({ ok: true, url, slot: slot === "logo" ? "logo" : "profile" });
    } catch (e) {
      console.error("[barber/media]", e);
      return res.status(500).json({ error: "server_error", message: e?.message || String(e) });
    }
  });
}
