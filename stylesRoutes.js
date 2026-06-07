import express from "express";
import multer from "multer";
import { createRequire } from "node:module";
import { dbQuery } from "./db.js";
import { STYLE_CATEGORIES } from "./stylesMigrations.js";
import { requireAuthOrAdminSecret, requireRole } from "./authRoutes.js";
import { uploadBarberStyleImage, deleteBarberStyleImageFromUrl } from "./src/services/storageUpload.js";
import { listStylesWithImages } from "./src/services/barberCmsStore.js";
import { getProfileById } from "./src/services/barberProfileStore.js";

const requireCjs = createRequire(import.meta.url);
const {
  listAllPublishedBookingStyles,
  listAllBookingStylesForAdmin,
  listPublishedBookingStylesForBarber,
  resolveBookingStyleRow,
  upsertBarberServiceStyle,
  setBarberServicePublished,
  deleteBarberServiceStyle,
  parseServiceStyleId,
} = requireCjs("./publicBookingStyles.cjs");
const { assertPersistableImageUrl, isPlaceholderImageUrl } = requireCjs("./styleImageUrl.cjs");
const { isUuidBarberId } = requireCjs("./barberIdentity.cjs");

function normalizeCategory(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return STYLE_CATEGORIES.includes(v) ? v : "other";
}

function getTokenRole(req) {
  return String(req.user?.role || "").trim();
}

function pickUploadFile(req) {
  return (
    req.file ||
    req.files?.image?.[0] ||
    req.files?.photo?.[0] ||
    req.files?.file?.[0] ||
    null
  );
}

function logStyleUpload(stage, req, file, extra = {}) {
  console.info(`[styles-upload] ${stage}`, {
    barberId: req.body?.barberId ?? req.body?.barber_id,
    styleId: req.params?.id,
    title: req.body?.title,
    contentType: req.headers["content-type"],
    filePresent: Boolean(file?.buffer?.length),
    originalname: file?.originalname,
    mimetype: file?.mimetype,
    size: file?.buffer?.length ?? 0,
    ...extra,
  });
}

function isUnsupportedImageFile(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  return (
    /\.heic$/.test(name) ||
    /\.heif$/.test(name) ||
    mime.includes("heic") ||
    mime.includes("heif")
  );
}

async function getBarberIdForBarberUser(userId) {
  const r = await dbQuery("SELECT barber_id FROM app_users WHERE id = $1::uuid LIMIT 1", [String(userId)]);
  const id = r.rows?.[0]?.barber_id;
  if (id == null || String(id).trim() === "") return null;
  return String(id).trim();
}

export function createStylesRouter() {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  // Public — published bookable styles (barber_services + legacy styles table)
  router.get("/", async (_req, res) => {
    try {
      const styles = await listAllPublishedBookingStyles(dbQuery);
      res.set("Cache-Control", "public, max-age=30");
      return res.json({ ok: true, styles });
    } catch (e) {
      console.error("[styles] public list:", e);
      return res.status(500).json({ error: "list_failed", message: e?.message || String(e) });
    }
  });

  /** Admin/barber — all styles including unpublished (for Styles Management). */
  router.get(
    "/manage/all",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber", "shop_owner"]),
    async (_req, res) => {
      try {
        const styles = await listAllBookingStylesForAdmin(dbQuery);
        res.set("Cache-Control", "no-store");
        return res.json({ ok: true, styles });
      } catch (e) {
        console.error("[styles] admin list:", e);
        return res.status(500).json({ error: "list_failed", message: e?.message || String(e) });
      }
    },
  );

  /** Public: single style by id (svc-* or UUID). */
  router.get("/by/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    const style = await resolveBookingStyleRow(dbQuery, id);
    if (!style) return res.status(404).json({ error: "not_found" });
    return res.json({ style });
  });

  // Back-compat path (must be before "/:barberId" so "barber" is not parsed as id)
  router.get("/barber/:barberId", async (req, res) => {
    const barberIdRaw = String(req.params.barberId || "").trim();
    if (!barberIdRaw) return res.status(400).json({ error: "invalid_barber_id" });

    const published = await listPublishedBookingStylesForBarber(dbQuery, barberIdRaw);
    if (published.length) {
      return res.json({ ok: true, barberId: barberIdRaw, styles: published });
    }

    const barberId = Number(barberIdRaw);
    if (Number.isFinite(barberId)) {
      try {
        const cms = await listStylesWithImages(barberId);
        if (cms.length) {
          return res.json({ ok: true, barberId, styles: cms });
        }
      } catch (e) {
        console.warn("[styles] CMS list fallback:", e?.message || e);
      }
    }
    return res.json({ ok: true, barberId: barberIdRaw, styles: [] });
  });

  // Public list by barber id (UUID or numeric)
  router.get("/:barberId", async (req, res) => {
    const barberIdRaw = String(req.params.barberId || "").trim();
    if (!barberIdRaw || barberIdRaw === "by") return res.status(400).json({ error: "invalid_barber_id" });
    const styles = await listPublishedBookingStylesForBarber(dbQuery, barberIdRaw);
    return res.json({ ok: true, styles });
  });

  // Create style (multipart: image + fields)
  router.post(
    "/",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber", "shop_owner"]),
    upload.fields([
      { name: "image", maxCount: 1 },
      { name: "photo", maxCount: 1 },
      { name: "file", maxCount: 1 },
    ]),
    async (req, res) => {
      const role = getTokenRole(req);
      const title = String(req.body?.title || "").trim();
      const description = String(req.body?.description || "").trim() || null;
      const category = normalizeCategory(req.body?.category);
      const barberIdRaw = req.body?.barber_id ?? req.body?.barberId;
      const priceRaw = Number(req.body?.price ?? req.body?.stylePrice);
      const price = Number.isFinite(priceRaw) && priceRaw > 0 ? Math.round(priceRaw * 100) / 100 : 25;
      const file = pickUploadFile(req);
      logStyleUpload("create", req, file);

      if (!title) return res.status(400).json({ error: "title_required" });

      let barberId = barberIdRaw;
      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId) return res.status(403).json({ error: "barber_unlinked", message: "Barber account not linked to a barberId." });
        barberId = myBarberId;
      }
      if (barberId == null || String(barberId).trim() === "") {
        return res.status(400).json({ error: "barber_id_required" });
      }

      let imageUrl = String(req.body?.image_url || req.body?.imageUrl || "").trim();
      if (isPlaceholderImageUrl(imageUrl)) {
        return res.status(400).json({
          error: "placeholder_not_allowed",
          message: "Cannot save the default placeholder as an uploaded photo.",
        });
      }

      const barberIdText = String(barberId).trim();
      let barberName = `barber-${barberIdText}`;
      if (isUuidBarberId(barberIdText)) {
        const br = await dbQuery(`SELECT name FROM barbers WHERE id::text = $1 LIMIT 1`, [barberIdText]);
        barberName = br.rows?.[0]?.name || barberName;
      } else {
        const profile = await getProfileById(Number(barberIdText));
        barberName = profile?.name || barberName;
      }

      if (file?.buffer?.length) {
        if (isUnsupportedImageFile(file)) {
          return res.status(400).json({
            error: "unsupported_format",
            message: "Please upload JPEG or PNG (HEIC/HEIF is not supported in web browsers).",
          });
        }
        const { url } = await uploadBarberStyleImage({
          buffer: file.buffer,
          mimetype: file.mimetype,
          barberName,
          originalName: file.originalname || "style.jpg",
        });
        imageUrl = url;
        logStyleUpload("create uploaded", req, file, { imageUrl: url });
      }

      if (!imageUrl) {
        return res.status(400).json({
          error: "image_required",
          message: "A real image file is required (multipart field `image`). Placeholder images are not saved.",
        });
      }

      try {
        assertPersistableImageUrl(imageUrl, "image_url");
      } catch (e) {
        return res.status(400).json({ error: "invalid_image_url", message: e.message || String(e) });
      }

      if (isUuidBarberId(barberIdText) || !Number.isFinite(Number(barberIdText))) {
        const style = await upsertBarberServiceStyle(dbQuery, {
          barberId: barberIdText,
          name: title,
          description,
          category,
          price,
          durationMinutes: Number(req.body?.durationMinutes) || 30,
          imageUrl,
          isActive: req.body?.is_published !== false && req.body?.isPublished !== false,
        });
        return res.json({ ok: true, style });
      }

      const r = await dbQuery(
        `INSERT INTO styles (barber_id, title, description, image_url, category, price, is_published)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING id, barber_id, title, description, image_url, category, price::float8 AS price, created_at`,
        [Number(barberIdText), title, description, imageUrl, category, price]
      );
      res.json({ ok: true, style: r.rows?.[0] });
    }
  );

  router.patch(
    "/:id/publish",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber"]),
    async (req, res) => {
      const id = String(req.params.id || "").trim();
      const published = req.body?.is_published ?? req.body?.isPublished ?? req.body?.published ?? true;
      try {
        if (parseServiceStyleId(id) != null || /^\d+$/.test(id)) {
          const style = await setBarberServicePublished(dbQuery, id, Boolean(published));
          return res.json({ ok: true, style, is_published: style.is_published });
        }
        const updated = await dbQuery(
          `UPDATE styles SET is_published = $2 WHERE id = $1::uuid
           RETURNING id, barber_id, title, description, image_url, category, price::float8 AS price, is_published`,
          [id, Boolean(published)],
        );
        if (!updated.rows?.length) return res.status(404).json({ error: "not_found" });
        return res.json({ ok: true, style: updated.rows[0], is_published: updated.rows[0].is_published });
      } catch (e) {
        const msg = e?.message || String(e);
        if (msg === "not_found") return res.status(404).json({ error: "not_found" });
        return res.status(500).json({ error: "publish_failed", message: msg });
      }
    },
  );

  router.put(
    "/:id",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber", "shop_owner"]),
    async (req, res) => {
      const id = String(req.params.id || "").trim();
      const role = getTokenRole(req);
      const title = req.body?.title != null ? String(req.body.title).trim() : null;
      const description = req.body?.description != null ? String(req.body.description).trim() : null;
      const category = req.body?.category != null ? normalizeCategory(req.body.category) : null;
      const price =
        req.body?.price != null || req.body?.stylePrice != null
          ? (() => {
              const n = Number(req.body?.price ?? req.body?.stylePrice);
              return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
            })()
          : null;
      const isPublished = req.body?.is_published ?? req.body?.isPublished;

      const serviceId = parseServiceStyleId(id);
      if (serviceId != null) {
        const existing = await resolveBookingStyleRow(dbQuery, id);
        if (!existing) return res.status(404).json({ error: "not_found" });
        const style = await upsertBarberServiceStyle(dbQuery, {
          barberId: existing.barber_id,
          name: title || existing.title,
          description: description ?? existing.description,
          category: category || existing.category,
          price: price ?? existing.price,
          serviceId,
          isActive: isPublished == null ? existing.is_published : Boolean(isPublished),
        });
        return res.json({ ok: true, style });
      }

      const existing = await dbQuery(`SELECT id, barber_id FROM styles WHERE id = $1::uuid LIMIT 1`, [id]);
      const row = existing.rows?.[0] || null;
      if (!row) return res.status(404).json({ error: "not_found" });

      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId || String(row.barber_id) !== String(myBarberId)) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const updated = await dbQuery(
        `UPDATE styles
         SET title = COALESCE($2, title),
             description = COALESCE($3, description),
             category = COALESCE($4, category),
             price = COALESCE($5, price),
             is_published = CASE WHEN $6::boolean IS NULL THEN is_published ELSE $6::boolean END
         WHERE id = $1::uuid
         RETURNING id, barber_id, title, description, image_url, category, price::float8 AS price, is_published, created_at`,
        [id, title, description, category, price, isPublished == null ? null : Boolean(isPublished)]
      );
      res.json({ ok: true, style: updated.rows?.[0] });
    }
  );

  router.delete(
    "/:id",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber", "shop_owner"]),
    async (req, res) => {
      const id = String(req.params.id || "").trim();
      const role = getTokenRole(req);

      const serviceId = parseServiceStyleId(id);
      if (serviceId != null) {
        try {
          const removed = await deleteBarberServiceStyle(dbQuery, id);
          if (removed?.image_url) {
            await deleteBarberStyleImageFromUrl(removed.image_url).catch((e) => {
              console.warn("[styles] storage delete skipped:", e?.message || e);
            });
          }
          return res.json({ ok: true, deletedId: id, hardDeleted: true });
        } catch (e) {
          const msg = e?.message || String(e);
          if (msg === "not_found") return res.status(404).json({ error: "not_found" });
          throw e;
        }
      }

      const existing = await dbQuery(`SELECT id, barber_id, image_url FROM styles WHERE id = $1::uuid LIMIT 1`, [id]);
      const row = existing.rows?.[0] || null;
      if (!row) return res.status(404).json({ error: "not_found" });

      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId || String(row.barber_id) !== String(myBarberId)) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      await dbQuery(`DELETE FROM styles WHERE id = $1::uuid`, [id]);
      if (row.image_url) {
        await deleteBarberStyleImageFromUrl(row.image_url).catch((e) => {
          console.warn("[styles] legacy storage delete skipped:", e?.message || e);
        });
      }
      res.json({ ok: true, deletedId: id, hardDeleted: true });
    }
  );

  /** Replace style/service image (multipart field `image`). */
  router.post(
    "/:id/image",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber", "shop_owner"]),
    upload.fields([
      { name: "image", maxCount: 1 },
      { name: "photo", maxCount: 1 },
      { name: "file", maxCount: 1 },
    ]),
    async (req, res) => {
      const id = String(req.params.id || "").trim();
      const file = pickUploadFile(req);
      logStyleUpload("replace", req, file, { styleId: id });
      if (!file?.buffer?.length) {
        return res.status(400).json({ error: "image_required", message: "Multipart field `image` is required" });
      }
      if (isUnsupportedImageFile(file)) {
        return res.status(400).json({
          error: "unsupported_format",
          message: "Please upload JPEG or PNG (HEIC/HEIF is not supported in web browsers).",
        });
      }

      const existing = await resolveBookingStyleRow(dbQuery, id);
      let row = existing;
      const serviceId = parseServiceStyleId(id);
      if (!row && serviceId != null) {
        const r = await dbQuery(
          `SELECT id, barber_id, name, description, category, icon, image_url,
                  price::float8 AS price, duration_minutes, is_active
           FROM barber_services WHERE id = $1 LIMIT 1`,
          [serviceId],
        );
        row = r.rows?.[0]
          ? {
              id,
              barber_id: r.rows[0].barber_id,
              title: r.rows[0].name,
              description: r.rows[0].description,
              category: r.rows[0].category,
              image_url: r.rows[0].image_url,
              price: r.rows[0].price,
              duration_minutes: r.rows[0].duration_minutes,
              is_published: r.rows[0].is_active !== false,
            }
          : null;
      }
      if (!row) return res.status(404).json({ error: "not_found", message: "Style not found" });

      const role = getTokenRole(req);
      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId || String(row.barber_id) !== String(myBarberId)) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const barberIdText = String(row.barber_id || "").trim();
      let barberName = `barber-${barberIdText}`;
      if (isUuidBarberId(barberIdText)) {
        const br = await dbQuery(`SELECT name FROM barbers WHERE id::text = $1 LIMIT 1`, [barberIdText]);
        barberName = br.rows?.[0]?.name || barberName;
      }

      const priorImageUrl = row.image_url || "";
      const { url } = await uploadBarberStyleImage({
        buffer: file.buffer,
        mimetype: file.mimetype,
        barberName,
        originalName: file.originalname || "style.jpg",
      });
      logStyleUpload("replace uploaded", req, file, { styleId: id, imageUrl: url });

      if (serviceId != null) {
        const style = await upsertBarberServiceStyle(dbQuery, {
          barberId: row.barber_id,
          name: row.title,
          description: row.description,
          category: row.category,
          price: row.price,
          durationMinutes: row.duration_minutes || 30,
          imageUrl: url,
          isActive: row.is_published !== false,
          serviceId,
        });
        if (priorImageUrl && priorImageUrl !== url) {
          await deleteBarberStyleImageFromUrl(priorImageUrl).catch(() => {});
        }
        return res.json({ ok: true, style });
      }

      await dbQuery(`UPDATE styles SET image_url = $2 WHERE id = $1::uuid`, [id, url]);
      if (priorImageUrl && priorImageUrl !== url) {
        await deleteBarberStyleImageFromUrl(priorImageUrl).catch(() => {});
      }
      const refreshed = await resolveBookingStyleRow(dbQuery, id);
      return res.json({ ok: true, style: refreshed || row });
    },
  );

  return router;
}

