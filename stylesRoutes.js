import express from "express";
import multer from "multer";
import { dbQuery } from "./db.js";
import { STYLE_CATEGORIES } from "./stylesMigrations.js";
import { requireAuthOrAdminSecret, requireRole } from "./authRoutes.js";
import { uploadBarberStyleImage } from "./src/services/storageUpload.js";
import { listStylesWithImages } from "./src/services/barberCmsStore.js";
import { getProfileById } from "./src/services/barberProfileStore.js";

function normalizeCategory(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return STYLE_CATEGORIES.includes(v) ? v : "other";
}

function getTokenRole(req) {
  return String(req.user?.role || "").trim();
}

async function getBarberIdForBarberUser(userId) {
  const r = await dbQuery("SELECT barber_id FROM app_users WHERE id = $1 LIMIT 1", [String(userId)]);
  const id = r.rows?.[0]?.barber_id;
  return id == null ? null : Number(id);
}

export function createStylesRouter() {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  // Public
  router.get("/", async (_req, res) => {
    const r = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price, created_at
       FROM styles
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json({ styles: r.rows || [] });
  });

  /** Public: single style by UUID (used for pricing validation). */
  router.get("/by/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    const r = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price, created_at
       FROM styles
       WHERE id = $1::uuid
       LIMIT 1`,
      [id]
    );
    const row = r.rows?.[0];
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ style: row });
  });

  // Back-compat path (must be before "/:barberId" so "barber" is not parsed as id)
  router.get("/barber/:barberId", async (req, res) => {
    const barberId = Number(req.params.barberId);
    if (!Number.isFinite(barberId)) return res.status(400).json({ error: "invalid_barber_id" });
    try {
      const cms = await listStylesWithImages(barberId);
      if (cms.length) {
        return res.json({ ok: true, barberId, styles: cms });
      }
    } catch (e) {
      console.warn("[styles] CMS list fallback:", e?.message || e);
    }
    const r = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price, created_at
       FROM styles
       WHERE barber_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [barberId]
    );
    res.json({ styles: r.rows || [] });
  });

  // Public (numeric barber id)
  router.get("/:barberId", async (req, res) => {
    const barberId = Number(req.params.barberId);
    if (!Number.isFinite(barberId)) return res.status(400).json({ error: "invalid_barber_id" });
    const r = await dbQuery(
      `SELECT id, barber_id, title, description, image_url, category, price::float8 AS price, created_at
       FROM styles
       WHERE barber_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [barberId]
    );
    res.json({ styles: r.rows || [] });
  });

  // Create style (multipart: image + fields)
  router.post(
    "/",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber"]),
    upload.single("image"),
    async (req, res) => {
      const role = getTokenRole(req);
      const title = String(req.body?.title || "").trim();
      const description = String(req.body?.description || "").trim() || null;
      const category = normalizeCategory(req.body?.category);
      const barberIdRaw = req.body?.barber_id ?? req.body?.barberId;
      const priceRaw = Number(req.body?.price ?? req.body?.stylePrice);
      const price = Number.isFinite(priceRaw) && priceRaw > 0 ? Math.round(priceRaw * 100) / 100 : 25;

      if (!title) return res.status(400).json({ error: "title_required" });

      let barberId = Number(barberIdRaw);
      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId) return res.status(403).json({ error: "barber_unlinked", message: "Barber account not linked to a barberId." });
        barberId = myBarberId;
      }
      if (!Number.isFinite(barberId)) return res.status(400).json({ error: "barber_id_required" });

      let imageUrl = String(req.body?.image_url || req.body?.imageUrl || "").trim();
      if (req.file?.buffer?.length) {
        const profile = await getProfileById(barberId);
        const barberName = profile?.name || `barber-${barberId}`;
        const { url } = await uploadBarberStyleImage({
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          barberName,
          originalName: req.file.originalname || "style.jpg",
        });
        imageUrl = url;
      }
      if (!imageUrl) return res.status(400).json({ error: "image_required" });

      const r = await dbQuery(
        `INSERT INTO styles (barber_id, title, description, image_url, category, price)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, barber_id, title, description, image_url, category, price::float8 AS price, created_at`,
        [barberId, title, description, imageUrl, category, price]
      );
      res.json({ ok: true, style: r.rows?.[0] });
    }
  );

  router.put(
    "/:id",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber"]),
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

      const existing = await dbQuery(`SELECT id, barber_id FROM styles WHERE id = $1 LIMIT 1`, [id]);
      const row = existing.rows?.[0] || null;
      if (!row) return res.status(404).json({ error: "not_found" });

      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId || Number(row.barber_id) !== Number(myBarberId)) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const updated = await dbQuery(
        `UPDATE styles
         SET title = COALESCE($2, title),
             description = COALESCE($3, description),
             category = COALESCE($4, category),
             price = COALESCE($5, price)
         WHERE id = $1
         RETURNING id, barber_id, title, description, image_url, category, price::float8 AS price, created_at`,
        [id, title, description, category, price]
      );
      res.json({ ok: true, style: updated.rows?.[0] });
    }
  );

  router.delete(
    "/:id",
    requireAuthOrAdminSecret,
    requireRole(["super_admin", "admin", "barber"]),
    async (req, res) => {
      const id = String(req.params.id || "").trim();
      const role = getTokenRole(req);

      const existing = await dbQuery(`SELECT id, barber_id FROM styles WHERE id = $1 LIMIT 1`, [id]);
      const row = existing.rows?.[0] || null;
      if (!row) return res.status(404).json({ error: "not_found" });

      if (role === "barber") {
        const myBarberId = await getBarberIdForBarberUser(req.user?.id);
        if (!myBarberId || Number(row.barber_id) !== Number(myBarberId)) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      await dbQuery(`DELETE FROM styles WHERE id = $1`, [id]);
      res.json({ ok: true, deletedId: id });
    }
  );

  return router;
}

