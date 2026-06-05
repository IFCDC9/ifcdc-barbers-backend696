import express from "express"
import { requireAdminOrAuth } from "../middleware/requireAdminOrAuth.js"
import { uploadMemory } from "../middleware/uploadMemory.js"
import { uploadBarberStyleImage } from "../services/storageUpload.js"
import { requireAuth } from "../../authRoutes.js"

const router = express.Router()

function uploadFileOrPhoto(req, res, next) {
  uploadMemory.single("file")(req, res, (err) => {
    if (err) return next(err)
    if (req.file) return next()
    uploadMemory.single("photo")(req, res, next)
  })
}

/** POST /api/upload — admin key or JWT; multipart field `file` or `photo`; optional barberName for storage path */
router.post("/", requireAdminOrAuth(requireAuth), uploadFileOrPhoto, async (req, res) => {
  try {
    const file = req.file
    if (!file?.buffer?.length) {
      return res.status(400).json({
        ok: false,
        error: "file_required",
        message: "Multipart field `file` or `photo` is required",
      })
    }
    const barberName = String(req.body?.barberName || req.body?.barber || "upload").trim() || "upload"
    const { url } = await uploadBarberStyleImage({
      buffer: file.buffer,
      mimetype: file.mimetype,
      barberName,
      originalName: file.originalname || "upload.jpg",
    })
    return res.status(201).json({ ok: true, image_url: url, url })
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "upload_failed",
      message: e instanceof Error ? e.message : String(e),
    })
  }
})

export default router
