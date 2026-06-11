import express from "express"
import { createRequire } from "node:module"
import db from "../db/db.js"
import { requireAdmin } from "../middleware/requireAdmin.js"
import { uploadMemory } from "../middleware/uploadMemory.js"
import {
  ensureBarberStylePhotosTable,
  listStylesByBarber,
  insertStylePhoto,
} from "../services/barberStylePhotoStore.js"
import { uploadBarberStyleImage } from "../services/storageUpload.js"
import { listBarberStylesObjects } from "../services/storageListService.js"

const requireCjs = createRequire(import.meta.url)
const {
  insertGalleryImage,
  resolveBarberUuidByName,
  listGalleryStylesForBarber,
} = requireCjs("../../styleGalleryStore.cjs")

const dbQuery = (text, params) => db.query(text, params)

const router = express.Router()

const norm = (v) => String(v || "").trim()

const parseTags = (raw) => {
  const s = norm(raw)
  if (!s) return []
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20)
}

/**
 * GET /api/barbers/styles?barber=Marcus%20Reed
 * Public: gallery data for client.
 */
/**
 * GET /api/barbers/storage/list?prefix=&limit=100
 * Admin: list objects in Storage (same as supabase.storage.from('barber-styles').list(...)).
 */
/**
 * GET /api/barbers/roster
 * Public: barber display names from DB (styles + barbers table) for website sync.
 */
router.get("/roster", async (_req, res) => {
  const names = new Set()
  try {
    await ensureBarberStylePhotosTable()
    const r = await db.query(
      `SELECT DISTINCT TRIM(barber_name) AS n FROM barber_style_photos WHERE TRIM(barber_name) <> ''`
    )
    for (const row of r.rows || []) {
      if (row.n) names.add(String(row.n).trim())
    }
  } catch (e) {
    console.warn("[barbers/roster] style photos:", e?.message || e)
  }
  try {
    const r2 = await db.query(
      `SELECT DISTINCT TRIM(name) AS n FROM barbers WHERE TRIM(COALESCE(name,'')) <> ''`
    )
    for (const row of r2.rows || []) {
      if (row.n) names.add(String(row.n).trim())
    }
  } catch {
    // `barbers` table may be absent in some environments
  }
  const barbers = [...names].sort((a, b) => a.localeCompare(b))
  res.json({ ok: true, barbers })
})

router.get("/storage/list", requireAdmin, async (req, res) => {
  try {
    const prefix = norm(req.query?.prefix)
    const limit = Number(req.query?.limit) || 100
    const result = await listBarberStylesObjects({ prefix, limit })
    if (!result.ok) {
      return res.status(result.error === "supabase_service_not_configured" ? 503 : 500).json({
        ok: false,
        error: result.error,
        items: [],
      })
    }
    res.json({ ok: true, bucket: result.bucket, items: result.items })
  } catch (e) {
    console.error("[barbers/storage/list] error:", e)
    res.status(500).json({ ok: false, error: "list_failed" })
  }
})

router.get("/styles", async (req, res) => {
  try {
    const barber = norm(req.query?.barber)
    if (!barber) {
      return res.status(400).json({ ok: false, error: "validation_failed", message: "barber query required" })
    }
    const barberUuid = await resolveBarberUuidByName(dbQuery, barber)
    if (barberUuid) {
      const gallery = await listGalleryStylesForBarber(dbQuery, barberUuid)
      if (gallery.length) {
        return res.json({
          ok: true,
          barberName: barber,
          barberId: barberUuid,
          styles: gallery.map((row) => ({
            id: row.id,
            styleName: row.title,
            price: Number(row.price),
            durationMinutes: row.duration_minutes,
            imageUrl: row.image_url,
            tags: [],
            createdAt: row.created_at,
          })),
        })
      }
    }
    const styles = await listStylesByBarber(barber)
    res.json({
      ok: true,
      barberName: barber,
      styles: styles.map((row) => ({
        id: row.id,
        styleName: row.style_name,
        price: Number(row.price),
        durationMinutes: row.duration_minutes,
        imageUrl: row.image_url,
        tags: row.tags || [],
        createdAt: row.created_at,
      })),
    })
  } catch (e) {
    console.error("[barbers/styles] list error:", e)
    res.status(500).json({ ok: false, error: "list_failed" })
  }
})

/**
 * POST /api/barbers/styles (admin)
 * multipart: photo, barberName, styleName, price, duration (minutes), tags (optional comma-separated)
 */
router.post("/styles", requireAdmin, uploadMemory.single("photo"), async (req, res) => {
  try {
    const file = req.file
    const barberName = norm(req.body?.barberName)
    const styleName = norm(req.body?.styleName)
    const price = Number(req.body?.price)
    const duration = Number(req.body?.duration ?? req.body?.durationMinutes)

    if (!file?.buffer?.length) {
      return res.status(400).json({ ok: false, error: "photo_required", message: "photo file is required" })
    }
    if (!barberName || !styleName) {
      return res.status(400).json({ ok: false, error: "validation_failed", message: "barberName and styleName required" })
    }
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ ok: false, error: "validation_failed", message: "valid price required" })
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 480) {
      return res.status(400).json({ ok: false, error: "validation_failed", message: "duration (minutes) must be 1–480" })
    }

    const tags = parseTags(req.body?.tags)
    const { url } = await uploadBarberStyleImage({
      buffer: file.buffer,
      mimetype: file.mimetype,
      barberName,
      originalName: file.originalname,
    })

    const barberUuid = await resolveBarberUuidByName(dbQuery, barberName)
    let row = null
    if (barberUuid) {
      row = await insertGalleryImage(dbQuery, {
        barberId: barberUuid,
        title: styleName,
        description: tags.length ? tags.join(", ") : "",
        category: "other",
        price,
        durationMinutes: Math.floor(duration),
        imageUrl: url,
        isPublished: true,
      })
    } else {
      row = await insertStylePhoto({
        barberName,
        styleName,
        price,
        durationMinutes: Math.floor(duration),
        imageUrl: url,
        tags,
      })
    }

    console.log("[barbers/styles] created:", { id: row?.id, barberName, styleName, persisted: Boolean(row?.id) })
    res.status(201).json({ ok: true, style: row, persisted: true })
  } catch (e) {
    console.error("[barbers/styles] upload error:", e)
    res.status(500).json({ ok: false, error: "upload_failed", message: e instanceof Error ? e.message : String(e) })
  }
})

export default router
