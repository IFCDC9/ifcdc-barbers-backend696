import express from "express";
import multer from "multer";
import { dbQuery } from "./db.js";
import { uploadBarberStyleImage } from "./src/services/storageUpload.js";
import {
  listProfiles,
  getProfileById,
  createProfile,
  updateProfileById,
  deleteProfileById,
} from "./src/services/barberProfileStore.js";
import { listStylesWithImages } from "./src/services/barberCmsStore.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function manageMiddleware(options = {}) {
  const manage =
    typeof options.manageMiddleware === "function" ? options.manageMiddleware : (_req, _res, next) => next();
  return manage;
}

function mapProfileToBarber(p, extra = {}) {
  const galleryUrls = Array.isArray(p.gallery)
    ? p.gallery.map((g) => (typeof g === "string" ? g : g?.url)).filter(Boolean)
    : [];
  const img = p.profileImageUrl || "";
  return {
    id: p.id,
    name: p.name,
    specialty: p.bio || "",
    bio: p.bio || "",
    image: img,
    photo: img,
    styles: galleryUrls,
    location: {
      address: p.address || "",
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
    },
    paymentMode: extra.paymentMode || "platform",
    splitPercent: extra.splitPercent ?? 80,
    active: extra.active !== false,
  };
}

async function listPublicBarbersFromDb() {
  const profiles = await listProfiles();
  if (profiles.length) {
    const rows = [];
    for (const p of profiles) {
      let paymentMode = "platform";
      let splitPercent = 80;
      let active = true;
      try {
        const st = await dbQuery(
          `SELECT payment_mode, split_percent, is_active FROM barber_settings WHERE barber_id::text = $1 LIMIT 1`,
          [String(p.id)],
        );
        const s = st.rows?.[0];
        if (s?.payment_mode && ["platform", "direct", "hybrid"].includes(s.payment_mode)) {
          paymentMode = s.payment_mode;
        }
        const sp = Number(s?.split_percent);
        if (Number.isFinite(sp) && sp >= 0 && sp <= 100) splitPercent = sp;
        if (s?.is_active === false) active = false;
      } catch {
        /* barber_settings columns may be absent on older DBs */
      }
      rows.push(mapProfileToBarber(p, { paymentMode, splitPercent, active }));
    }
    return rows;
  }

  const r = await dbQuery(
    `SELECT id, name, bio, profile_image, location FROM barbers ORDER BY LOWER(name) NULLS LAST LIMIT 500`,
  );
  return (r.rows || []).map((b) => ({
    id: b.id,
    name: b.name || "",
    specialty: b.bio || "",
    bio: b.bio || "",
    image: b.profile_image || "",
    photo: b.profile_image || "",
    styles: [],
    location: { address: String(b.location || ""), latitude: null, longitude: null },
    paymentMode: "platform",
    splitPercent: 80,
    active: true,
  }));
}

/**
 * Postgres-backed /barbers API (replaces in-memory minimalIfcdcApi for production persistence).
 */
export function mountProductionBarbersRoutes(app, options = {}) {
  const manage = manageMiddleware(options);
  const router = express.Router();

  router.get("/barbers", async (_req, res) => {
    try {
      const barbers = await listPublicBarbersFromDb();
      res.json(barbers);
    } catch (e) {
      console.error("[barbers] list:", e);
      res.status(500).json({ error: "list_failed", message: e?.message || String(e) });
    }
  });

  router.post(
    "/barbers",
    manage,
    upload.fields([
      { name: "photo", maxCount: 1 },
      { name: "image", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const name = String(req.body?.name ?? "").trim();
        if (!name) return res.status(400).json({ error: "name is required" });

        const file = req.files?.photo?.[0] || req.files?.image?.[0];
        let profileImageUrl = "";
        if (file?.buffer?.length) {
          const { url } = await uploadBarberStyleImage({
            buffer: file.buffer,
            mimetype: file.mimetype,
            barberName: name,
            originalName: file.originalname || "profile.jpg",
          });
          profileImageUrl = url;
        }

        const profile = await createProfile({ name, profileImageUrl });

        try {
          await dbQuery(
            `INSERT INTO barbers (name, profile_image, bio, location)
             SELECT $1, $2, '', ''
             WHERE NOT EXISTS (SELECT 1 FROM barbers b WHERE lower(trim(b.name)) = lower(trim($1)))`,
            [name, profileImageUrl || null],
          );
        } catch (e) {
          console.warn("[barbers] barbers table insert skipped:", e?.message || e);
        }

        res.json(mapProfileToBarber(profile));
      } catch (e) {
        console.error("[barbers] create:", e);
        const msg = e?.message || String(e);
        if (msg.includes("duplicate") || msg.includes("unique")) {
          return res.status(409).json({ error: "name_taken", message: "A barber with this name already exists" });
        }
        res.status(500).json({ error: "create_failed", message: msg });
      }
    },
  );

  router.post("/barbers/:id/styles", manage, upload.array("styles", 10), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

      const profile = await getProfileById(id);
      const barberName = profile?.name || `barber-${id}`;
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: "Add at least one image (field name: styles)" });
      }

      const urls = [];
      for (const file of files) {
        const { url } = await uploadBarberStyleImage({
          buffer: file.buffer,
          mimetype: file.mimetype,
          barberName,
          originalName: file.originalname || "style.jpg",
        });
        urls.push(url);
        const title = String(file.originalname || "Style")
          .replace(/\.[^.]+$/, "")
          .trim()
          .slice(0, 120) || "Style";
        await dbQuery(
          `INSERT INTO styles (barber_id, title, description, image_url, category, price)
           VALUES ($1, $2, NULL, $3, 'other', 25)`,
          [id, title, url],
        );
      }

      const cms = await listStylesWithImages(id);
      const styleUrls = cms.flatMap((s) => (Array.isArray(s.images) ? s.images.map((i) => i.url) : []));
      const allStyles = [...new Set([...urls, ...styleUrls])];

      res.json({
        id,
        name: barberName,
        photo: profile?.profileImageUrl || "",
        image: profile?.profileImageUrl || "",
        styles: allStyles,
      });
    } catch (e) {
      console.error("[barbers] styles upload:", e);
      res.status(500).json({ error: "upload_failed", message: e?.message || String(e) });
    }
  });

  router.patch("/barbers/:id", manage, express.json(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

      const profile = await getProfileById(id);
      if (!profile) return res.status(404).json({ error: "Not found" });

      const { paymentMode, splitPercent, active, location } = req.body || {};
      const patch = {};

      if (location !== undefined) {
        if (!location || typeof location !== "object") {
          return res.status(400).json({ error: "location must be an object" });
        }
        const address = location.address != null ? String(location.address).trim() : "";
        const lat = location.latitude != null && location.latitude !== "" ? Number(location.latitude) : null;
        const lng = location.longitude != null && location.longitude !== "" ? Number(location.longitude) : null;
        if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
          return res.status(400).json({ error: "location.latitude must be between -90 and 90" });
        }
        if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
          return res.status(400).json({ error: "location.longitude must be between -180 and 180" });
        }
        patch.address = address;
        patch.latitude = lat;
        patch.longitude = lng;
      }

      const updated = Object.keys(patch).length ? await updateProfileById(id, patch) : profile;

      if (paymentMode !== undefined || splitPercent !== undefined || active !== undefined) {
        try {
          const pm = paymentMode !== undefined && ["platform", "direct", "hybrid"].includes(paymentMode) ? paymentMode : null;
          const sp = splitPercent !== undefined ? Number(splitPercent) : null;
          await dbQuery(
            `INSERT INTO barber_settings (barber_id, payment_mode, split_percent, is_active)
             VALUES ($1, COALESCE($2, 'platform'), COALESCE($3, 80), COALESCE($4, true))
             ON CONFLICT (barber_id) DO UPDATE SET
               payment_mode = COALESCE($2, barber_settings.payment_mode),
               split_percent = COALESCE($3, barber_settings.split_percent),
               is_active = COALESCE($4, barber_settings.is_active)`,
            [id, pm, Number.isFinite(sp) ? sp : null, active !== undefined ? Boolean(active) : null],
          );
        } catch (e) {
          console.warn("[barbers] settings patch skipped:", e?.message || e);
        }
      }

      let paymentModeOut = "platform";
      let splitPercentOut = 80;
      let activeOut = true;
      try {
        const st = await dbQuery(
          `SELECT payment_mode, split_percent, is_active FROM barber_settings WHERE barber_id::text = $1 LIMIT 1`,
          [String(id)],
        );
        const s = st.rows?.[0];
        if (s?.payment_mode) paymentModeOut = s.payment_mode;
        const n = Number(s?.split_percent);
        if (Number.isFinite(n)) splitPercentOut = n;
        if (s?.is_active === false) activeOut = false;
      } catch {
        /* ignore */
      }

      res.json(mapProfileToBarber(updated, { paymentMode: paymentModeOut, splitPercent: splitPercentOut, active: activeOut }));
    } catch (e) {
      console.error("[barbers] patch:", e);
      res.status(500).json({ error: "patch_failed", message: e?.message || String(e) });
    }
  });

  router.delete("/barbers/:id", manage, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      await deleteProfileById(id);
      try {
        await dbQuery(`DELETE FROM barbers WHERE id::text = $1::text`, [String(id)]);
      } catch {
        /* barbers row may use different id shape */
      }
      res.json({ success: true, deleted: true });
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg === "not_found") return res.status(404).json({ error: "Not found" });
      console.error("[barbers] delete:", e);
      res.status(500).json({ error: "delete_failed", message: msg });
    }
  });

  app.use(router);
}
