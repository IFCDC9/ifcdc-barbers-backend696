import fs from "node:fs"
import path from "node:path"
import supabaseService from "../db/supabaseServiceClient.js"

const BUCKET = String(process.env.SUPABASE_STORAGE_BUCKET || "barber-styles").trim()

function slugPart(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "barber"
}

function isHeicUpload({ mimetype, originalName }) {
  const name = String(originalName || "").toLowerCase()
  const mime = String(mimetype || "").toLowerCase()
  return (
    /\.heic$/.test(name) ||
    /\.heif$/.test(name) ||
    mime.includes("heic") ||
    mime.includes("heif")
  )
}

function replaceExtension(originalName, nextExt) {
  const base = String(originalName || "photo").replace(/\.[^.]+$/, "")
  return `${base}${nextExt}`
}

function webSafeExtension(mimetype, originalName) {
  const mime = String(mimetype || "").toLowerCase()
  const ext = path.extname(String(originalName || "")).toLowerCase()
  if (mime.includes("png") || ext === ".png") return ".png"
  if (mime.includes("webp") || ext === ".webp") return ".webp"
  if (mime.includes("gif") || ext === ".gif") return ".gif"
  if (mime.includes("jpeg") || mime.includes("jpg") || ext === ".jpg" || ext === ".jpeg") return ".jpg"
  if (ext.match(/^\.(jpe?g|png|webp|gif)$/)) return ext
  return ".jpg"
}

function logUploadMeta(label, meta) {
  console.info(`[storage] ${label}`, meta)
}

/** Convert iPhone HEIC/HEIF camera photos to JPEG for browser display. */
async function normalizeUploadBuffer({ buffer, mimetype, originalName }) {
  if (!isHeicUpload({ mimetype, originalName })) {
    return { buffer, mimetype, originalName, converted: false }
  }

  try {
    const heicConvert = (await import("heic-convert")).default
    const converted = await heicConvert({
      buffer,
      format: "JPEG",
      quality: 0.92,
    })
    const out = Buffer.from(converted)
    logUploadMeta("heic converted to jpeg", {
      originalName: String(originalName || ""),
      inBytes: buffer.length,
      outBytes: out.length,
    })
    return {
      buffer: out,
      mimetype: "image/jpeg",
      originalName: replaceExtension(originalName, ".jpg"),
      converted: true,
    }
  } catch (e) {
    console.error("[storage] heic conversion failed:", e?.message || e)
    throw new Error(
      "heic_convert_failed: Could not convert iPhone photo. Try a JPEG/PNG export or screenshot.",
    )
  }
}

/**
 * Upload image buffer. Requires Supabase in production (no ephemeral disk saves).
 * HEIC/HEIF from iPhone cameras is converted to JPEG before upload.
 * @returns {Promise<{ url: string, storage: "supabase" | "local", converted?: boolean }>}
 */
export async function uploadBarberStyleImage({ buffer, mimetype, barberName, originalName }) {
  if (!buffer?.length) {
    throw new Error("file_empty")
  }

  const normalized = await normalizeUploadBuffer({ buffer, mimetype, originalName })
  buffer = normalized.buffer
  mimetype = normalized.mimetype
  originalName = normalized.originalName

  const safeExt = webSafeExtension(mimetype, originalName)
  const key = `${slugPart(barberName)}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`

  logUploadMeta("upload start", {
    barberName: slugPart(barberName),
    originalName: String(originalName || ""),
    mimetype: String(mimetype || ""),
    bytes: buffer.length,
    key,
    heicConverted: Boolean(normalized.converted),
  })

  if (supabaseService) {
    const { data, error } = await supabaseService.storage.from(BUCKET).upload(key, buffer, {
      contentType: mimetype || "image/jpeg",
      upsert: false,
    })
    if (error) throw new Error(error.message || "supabase_upload_failed")

    const { data: pub } = supabaseService.storage.from(BUCKET).getPublicUrl(data.path)
    const url = pub?.publicUrl
    if (!url) throw new Error("supabase_public_url_failed")
    if (url.includes("/uploads/")) {
      throw new Error("invalid_storage_url: Upload must use Supabase, not ephemeral disk")
    }
    logUploadMeta("uploaded supabase", { key, url, heicConverted: Boolean(normalized.converted) })
    return { url, storage: "supabase", converted: Boolean(normalized.converted) }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "supabase_not_configured: Photo storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
    )
  }

  const uploadsDir = path.join(process.cwd(), "uploads", "barber-styles")
  fs.mkdirSync(uploadsDir, { recursive: true })
  const filename = path.basename(key)
  const sub = path.dirname(key)
  const dir = path.join(uploadsDir, sub)
  fs.mkdirSync(dir, { recursive: true })
  const full = path.join(dir, filename)
  fs.writeFileSync(full, buffer)
  const url = `/uploads/barber-styles/${key.replace(/\\/g, "/")}`
  logUploadMeta("saved local dev disk", { url })
  return { url, storage: "local", converted: Boolean(normalized.converted) }
}

/** Extract storage object key from a Supabase public URL, if possible. */
export function supabaseObjectKeyFromPublicUrl(publicUrl) {
  const u = String(publicUrl || "").trim()
  if (!u.includes("supabase.co/storage/")) return null
  const needle = `/object/public/${BUCKET}/`
  const idx = u.indexOf(needle)
  if (idx === -1) return null
  return u.slice(idx + needle.length).split("?")[0] || null
}

/** Best-effort delete of a previously uploaded Supabase object. */
export async function deleteBarberStyleImageFromUrl(publicUrl) {
  const key = supabaseObjectKeyFromPublicUrl(publicUrl)
  if (!key || !supabaseService) {
    return { deleted: false, reason: key ? "no_supabase_client" : "not_supabase_url" }
  }
  const { error } = await supabaseService.storage.from(BUCKET).remove([key])
  if (error) {
    console.warn("[storage] delete failed:", key, error.message || error)
    return { deleted: false, reason: error.message || "delete_failed", key }
  }
  logUploadMeta("deleted supabase object", { key })
  return { deleted: true, key }
}
