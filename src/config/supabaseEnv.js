/**
 * Supabase API keys: new publishable/secret keys (sb_publishable_… / sb_secret_…)
 * with fallback to legacy anon / service_role JWT keys.
 * @see https://supabase.com/docs/guides/api/api-keys
 */

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveSupabasePublishableKey(env = process.env) {
  const publishable = String(env.SUPABASE_PUBLISHABLE_KEY || "").trim()
  const anon = String(env.SUPABASE_ANON_KEY || "").trim()
  return publishable || anon
}

/** @param {NodeJS.ProcessEnv} [env] */
function stripEnvQuotes(v) {
  let t = String(v || "").trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim()
  }
  return t
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveSupabaseSecretKey(env = process.env) {
  const secret = stripEnvQuotes(env.SUPABASE_SECRET_KEY || "")
  const serviceRole = stripEnvQuotes(env.SUPABASE_SERVICE_ROLE_KEY || "")
  return secret || serviceRole
}

/** Vite exposes import.meta.env in the client; on the Node side (validate only) use process.env. */
export function resolveViteSupabasePublishableKey(env = process.env) {
  const publishable = String(env.VITE_SUPABASE_PUBLISHABLE_KEY || "").trim()
  const anon = String(env.VITE_SUPABASE_ANON_KEY || "").trim()
  return publishable || anon
}

export function supabasePublishableKeySource() {
  if (String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim()) return "SUPABASE_PUBLISHABLE_KEY"
  if (String(process.env.SUPABASE_ANON_KEY || "").trim()) return "SUPABASE_ANON_KEY"
  return null
}

export function supabaseSecretKeySource() {
  if (String(process.env.SUPABASE_SECRET_KEY || "").trim()) return "SUPABASE_SECRET_KEY"
  if (String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()) return "SUPABASE_SERVICE_ROLE_KEY"
  return null
}

/**
 * Clear boot-time status for Supabase keys (no secret values logged).
 * Does not exit the process.
 */
export function logSupabaseKeyStatus() {
  const url = String(process.env.SUPABASE_URL || "").trim()
  if (!url) {
    console.log("[env] Supabase: SUPABASE_URL unset — optional unless you use Storage or Supabase APIs.")
    return
  }

  const pub = resolveSupabasePublishableKey()
  const sec = resolveSupabaseSecretKey()

  if (!pub) {
    console.error(
      "[env] Supabase: SUPABASE_URL is set but neither SUPABASE_PUBLISHABLE_KEY nor SUPABASE_ANON_KEY is set. " +
        "Add one from Dashboard → Settings → API keys (publishable or legacy anon). " +
        "The server public Supabase client stays disabled until this is fixed."
    )
  } else {
    const src = supabasePublishableKeySource()
    console.log(`[env] ✓ Supabase public key configured (${src})`)
  }

  if (!sec) {
    console.warn(
      "[env] Supabase: neither SUPABASE_SECRET_KEY nor SUPABASE_SERVICE_ROLE_KEY is set — " +
        "service client disabled (Storage admin uploads, auth bridge)."
    )
  } else {
    const src = supabaseSecretKeySource()
    console.log(`[env] ✓ Supabase secret/service key configured (${src})`)
  }
}
