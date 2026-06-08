import { createClient } from "@supabase/supabase-js"
import { resolveSupabaseSecretKey } from "../config/supabaseEnv.js"

let _client = null
let _lastInitError = null

function stripEnvQuotes(v) {
  let t = String(v || "").trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim()
  }
  return t
}

function supabaseUrl() {
  return stripEnvQuotes(process.env.SUPABASE_URL).replace(/\/+$/, "")
}

/** Lazy singleton — re-reads env on first use (safe after Render injects env at boot). */
export function getSupabaseServiceClient() {
  if (_client) return _client

  const url = supabaseUrl()
  const key = resolveSupabaseSecretKey()

  if (!url) {
    _lastInitError = "SUPABASE_URL missing"
    return null
  }
  if (!key) {
    _lastInitError = "SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY missing"
    return null
  }

  try {
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    _lastInitError = null
    console.log("[supabase] service client ready", { url: url.slice(0, 40) + "…" })
  } catch (e) {
    _lastInitError = e?.message || String(e)
    console.error("[supabase] service client init failed:", _lastInitError)
    _client = null
  }

  return _client
}

export function getSupabaseInitStatus() {
  const url = supabaseUrl()
  const secretConfigured = Boolean(resolveSupabaseSecretKey())
  const client = getSupabaseServiceClient()
  return {
    urlConfigured: Boolean(url),
    secretConfigured,
    clientReady: Boolean(client),
    lastError: _lastInitError,
    bucket: String(process.env.SUPABASE_STORAGE_BUCKET || "barber-styles").trim(),
    urlHost: url ? url.replace(/^https?:\/\//, "").split("/")[0] : null,
  }
}

/** List bucket root — confirms project + service role + bucket permissions. */
export async function probeSupabaseStorage() {
  const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || "barber-styles").trim()
  const client = getSupabaseServiceClient()
  if (!client) {
    return { ok: false, bucket, reason: _lastInitError || "client_not_ready" }
  }
  try {
    const { data, error } = await client.storage.from(bucket).list("", { limit: 1 })
    if (error) {
      return { ok: false, bucket, reason: error.message || "list_failed" }
    }
    return { ok: true, bucket, reachable: true, sampleObjects: data?.length ?? 0 }
  } catch (e) {
    return { ok: false, bucket, reason: e?.message || String(e) }
  }
}

/** Backward-compatible default export (lazy). */
export default new Proxy(
  {},
  {
    get(_target, prop) {
      const c = getSupabaseServiceClient()
      if (!c) return undefined
      const v = c[prop]
      return typeof v === "function" ? v.bind(c) : v
    },
  },
)
