import express from "express"
import { requireAdmin } from "../middleware/requireAdmin.js"
import { uploadMemory } from "../middleware/uploadMemory.js"
import { uploadBarberStyleImage } from "../services/storageUpload.js"
import {
  listStylesWithImages,
  createStyle,
  deleteStyle,
  addStyleImage,
  deleteStyleImage,
  getStyleBarberId,
} from "../services/barberCmsStore.js"
import { getProfileById } from "../services/barberProfileStore.js"

export const stylesRouter = express.Router()
export const imagesRouter = express.Router()

const jsonErr = (res, status, code, message) =>
  res.status(status).json({ ok: false, error: code, message })

async function listStylesHandler(barberId, res) {
  const bid = Number(barberId)
  if (!Number.isFinite(bid) || bid <= 0) {
    return jsonErr(res, 400, "invalid_barber_id", "Valid barberId required")
  }
  const p = await getProfileById(bid)
  if (!p) return jsonErr(res, 404, "barber_not_found", "Barber not found")
  const styles = await listStylesWithImages(bid)
  return res.json({ ok: true, barberId: bid, styles })
}

/** GET /api/styles/barber/:barberId — public */
stylesRouter.get("/barber/:barberId", async (req, res) => {
  try {
    return await listStylesHandler(req.params.barberId, res)
  } catch (e) {
    console.error("[cms/styles] list:", e)
    return jsonErr(res, 500, "list_failed", e instanceof Error ? e.message : String(e))
  }
})

/** GET /api/styles?barberId= — public alias (no barberId → fall through to legacy UUID styles list) */
stylesRouter.get("/", async (req, res, next) => {
  try {
    const barberId = req.query?.barberId
    if (barberId == null || String(barberId).trim() === "") {
      return next("router")
    }
    return await listStylesHandler(barberId, res)
  } catch (e) {
    console.error("[cms/styles] list:", e)
    return jsonErr(res, 500, "list_failed", e instanceof Error ? e.message : String(e))
  }
})

/** GET /api/styles/:barberId — public list by barber id (same as /barber/:barberId) */
stylesRouter.get("/:barberId(\\d+)", async (req, res) => {
  try {
    return await listStylesHandler(req.params.barberId, res)
  } catch (e) {
    console.error("[cms/styles] list:", e)
    return jsonErr(res, 500, "list_failed", e instanceof Error ? e.message : String(e))
  }
})

/** POST /api/styles — admin JSON create (multipart booking styles → legacy router) */
stylesRouter.post("/", (req, res, next) => {
  const ct = String(req.headers["content-type"] || "")
  if (ct.includes("multipart/form-data")) {
    return next("router")
  }
  return requireAdmin(req, res, next)
}, async (req, res) => {
  try {
    const style = await createStyle({
      barberId: req.body?.barberId,
      name: req.body?.name,
      styleName: req.body?.styleName,
      price: req.body?.price,
      durationMinutes: req.body?.durationMinutes ?? 30,
    })
    return res.status(201).json({ ok: true, style })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return jsonErr(res, 409, "style_exists", "A style with this name already exists for this barber")
    }
    if (msg === "invalid_barber_id" || msg === "name_required" || msg === "invalid_price" || msg === "invalid_duration") {
      return jsonErr(res, 400, msg, msg)
    }
    return jsonErr(res, 500, "create_failed", msg)
  }
})

/** DELETE /api/styles/:id — admin (style id) */
stylesRouter.delete("/:id(\\d+)", requireAdmin, async (req, res) => {
  try {
    await deleteStyle(req.params.id)
    return res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === "not_found") return jsonErr(res, 404, "not_found", "Style not found")
    return jsonErr(res, 500, "delete_failed", msg)
  }
})

/** POST /api/images — admin: JSON { styleId, url } or multipart styleId + photo */
imagesRouter.post(
  "/",
  requireAdmin,
  (req, res, next) => {
    const ct = String(req.headers["content-type"] || "")
    if (ct.includes("multipart/form-data")) {
      return uploadMemory.single("photo")(req, res, next)
    }
    next()
  },
  async (req, res) => {
    try {
      const styleId = Number(req.body?.styleId)
      if (!Number.isFinite(styleId) || styleId <= 0) {
        return jsonErr(res, 400, "styleId_required", "styleId required")
      }
      const barberId = await getStyleBarberId(styleId)
      if (barberId == null) return jsonErr(res, 404, "style_not_found", "Style not found")
      const profile = await getProfileById(barberId)
      const barberName = profile?.name || "barber"

      const file = req.file
      const urlBody = String(req.body?.url || "").trim()

      if (file?.buffer?.length) {
        const { url } = await uploadBarberStyleImage({
          buffer: file.buffer,
          mimetype: file.mimetype,
          barberName,
          originalName: file.originalname || "style.jpg",
        })
        const image = await addStyleImage({ styleId, url })
        return res.status(201).json({ ok: true, image })
      }

      if (urlBody) {
        const image = await addStyleImage({ styleId, url: urlBody })
        return res.status(201).json({ ok: true, image })
      }

      return jsonErr(res, 400, "photo_or_url_required", "Send multipart field `photo` or JSON body { styleId, url }")
    } catch (e) {
      return jsonErr(res, 500, "image_create_failed", e instanceof Error ? e.message : String(e))
    }
  }
)

/** DELETE /api/images/:id — admin */
imagesRouter.delete("/:id(\\d+)", requireAdmin, async (req, res) => {
  try {
    await deleteStyleImage(req.params.id)
    return res.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === "not_found") return jsonErr(res, 404, "not_found", "Image not found")
    return jsonErr(res, 500, "delete_failed", msg)
  }
})
