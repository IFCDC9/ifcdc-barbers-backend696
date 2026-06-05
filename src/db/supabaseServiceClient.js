import { createClient } from "@supabase/supabase-js"
import { resolveSupabaseSecretKey } from "../config/supabaseEnv.js"

const url = String(process.env.SUPABASE_URL || "").trim()
const key = resolveSupabaseSecretKey()

let client = null

if (url && key) {
  try {
    client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  } catch (e) {
    console.error("[supabase] service client init failed:", e?.message || e)
  }
} else if (url) {
  console.warn(
    "[supabase] SUPABASE_URL is set but no secret key — Storage uploads will use ephemeral local disk. " +
      "Set SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY on Render.",
  )
}

export default client
