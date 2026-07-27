import dns from "node:dns"
import { promisify } from "node:util"
import pkg from "pg"

/** Prefer IPv4 ordering globally. */
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first")
}

const { Pool } = pkg
const resolve4 = promisify(dns.resolve4)

const isProduction = process.env.NODE_ENV === "production"

function safeDecodeURIComponent(s) {
  if (s == null || s === "") return ""
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Direct `db.<ref>.supabase.co` is often IPv6-only; Render has no IPv6 route (ENETUNREACH).
 * Prefer Supabase transaction pooler (IPv4, port 6543) for production connectivity.
 */
function preferSupabaseTransactionPooler(raw) {
  const s = String(raw || "").trim()
  if (!s) return s
  try {
    const u = new URL(s)
    const host = String(u.hostname || "").toLowerCase()
    const m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)
    if (!m) return s
    const projectRef = m[1]
    const poolerHost =
      String(process.env.SUPABASE_POOLER_HOST || "").trim() ||
      "aws-1-us-east-1.pooler.supabase.com"
    const out = new URL(`postgresql://${poolerHost}:6543/postgres`)
    out.username = `postgres.${projectRef}`
    out.password = decodeURIComponent(u.password || "")
    out.searchParams.set("sslmode", "require")
    console.warn(
      `[db] Rewrote direct Supabase host ${host}:5432 → transaction pooler ${poolerHost}:6543 (avoids IPv6 ENETUNREACH on Render)`
    )
    return out.toString()
  } catch {
    return s
  }
}

/** Ensure Supabase URIs request TLS even if .env omitted sslmode. */
function normalizeDatabaseUrl(raw) {
  const preferred = preferSupabaseTransactionPooler(raw)
  const s = String(preferred || "").trim()
  if (!s) return s
  try {
    const host = new URL(s).hostname.toLowerCase()
    if (!host.includes("supabase.co")) return s
    if (/[?&]sslmode=/i.test(s)) return s
    return s + (s.includes("?") ? "&" : "?") + "sslmode=require"
  } catch {
    return s
  }
}

const resolvedDatabaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL)

/**
 * pg merges parse(connectionString) over Pool config; sslmode=require becomes ssl: {}
 * and is treated like verify-full, which breaks with some proxies/certs. Strip SSL query
 * params and pass explicit ssl on the Pool config instead.
 */
function stripSslQueryFromUrl(urlString) {
  let u
  try {
    u = new URL(urlString)
  } catch {
    return urlString
  }
  for (const key of [
    "sslmode",
    "ssl",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    u.searchParams.delete(key)
  }
  return u.toString()
}

function sslServernameFromUrl(urlString) {
  try {
    return new URL(urlString).hostname
  } catch {
    return undefined
  }
}

function shouldUseSsl(connectionString) {
  const raw = String(connectionString || "").trim()
  if (!raw) return isProduction
  try {
    const u = new URL(raw)
    const host = String(u.hostname || "").toLowerCase()
    if (host.includes("supabase.co")) return true
    const sslmode = String(u.searchParams.get("sslmode") || "").toLowerCase()
    if (sslmode === "require") return true
    if (sslmode === "disable") return false
  } catch {
    // ignore
  }
  return isProduction
}

function isSupabasePoolerHost(hostname) {
  return String(hostname || "").toLowerCase().includes("pooler.supabase.com")
}

function resolveSupabaseIpv4Sync(hostname) {
  if (typeof dns.lookupSync !== "function") return null
  try {
    const r = dns.lookupSync(hostname, { family: 4 })
    if (typeof r === "string") return r
    if (r && typeof r === "object" && r.address) return r.address
  } catch {
    /* fall through */
  }
  return null
}

async function resolveSupabaseIpv4Async(hostname) {
  const ms = Number(process.env.PG_DNS_RESOLVE_TIMEOUT_MS || 8000)
  try {
    const addrs = await Promise.race([
      resolve4(hostname),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("PG DNS resolve timeout")), ms)
      }),
    ])
    return addrs[0] || null
  } catch {
    return null
  }
}

async function buildPoolConfig() {
  const urlString = resolvedDatabaseUrl
  const max = Number(process.env.PG_POOL_MAX || 1)
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 10000)
  const connectionTimeoutMillis = Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000)
  const useSsl = shouldUseSsl(urlString)

  const base = {
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  }

  if (!urlString) {
    return { ...base, connectionString: undefined }
  }

  let u
  try {
    u = new URL(urlString)
  } catch {
    return { ...base, connectionString: urlString }
  }

  const hostname = u.hostname
  const hostLower = hostname.toLowerCase()
  const isSupabase = hostLower.includes("supabase.co")

  if (!isSupabase) {
    if (useSsl) {
      const cleaned = stripSslQueryFromUrl(urlString)
      return {
        ...base,
        connectionString: cleaned,
        ssl: {
          rejectUnauthorized: false,
          servername: sslServernameFromUrl(urlString),
        },
      }
    }
    return { ...base, connectionString: urlString }
  }

  /** Pooler must use real hostname — routing is tenant-aware; connecting by raw IP breaks auth. */
  if (isSupabasePoolerHost(hostname)) {
    const user = safeDecodeURIComponent(u.username || "").trim()
    const password = safeDecodeURIComponent(u.password || "").trim()
    const database = (u.pathname || "/postgres").replace(/^\//, "") || "postgres"
    const port = Number(u.port || 5432)

    if (!user || !password) {
      console.error("[db] Supabase pooler: missing username or password in DATABASE_URL")
    } else if (user === "postgres") {
      console.warn(
        "[db] Pooler username is literally \"postgres\" — Supabase expects postgres.<project-ref> (copy URI from Dashboard → Connect → Transaction pooler)."
      )
    } else if (!/^postgres\.[^@]+$/i.test(user)) {
      console.warn(
        "[db] Pooler username should look like postgres.<project-ref>; got format that may not match Supabase pooler."
      )
    }

    console.log(
      "[db] Supabase pooler:",
      hostname,
      "port",
      port,
      "user",
      user.replace(/^(postgres\.).+$/i, "$1<project-ref>"),
      "(explicit host/user — no connectionString merge)"
    )

    return {
      ...base,
      host: hostname,
      port,
      user,
      password,
      database,
      ssl: useSsl ? { rejectUnauthorized: false, servername: hostname } : false,
    }
  }

  let ipv4 = resolveSupabaseIpv4Sync(hostname)
  if (!ipv4 && typeof dns.lookupSync !== "function") {
    ipv4 = await resolveSupabaseIpv4Async(hostname)
  }

  if (!ipv4) {
    console.warn("[db] Could not resolve IPv4 for", hostname, "— using hostname (may hit IPv6 ECONNREFUSED on some networks).")
    const cleaned = stripSslQueryFromUrl(urlString)
    return {
      ...base,
      connectionString: cleaned,
      ssl: useSsl
        ? { rejectUnauthorized: false, servername: hostname }
        : false,
    }
  }

  const user = safeDecodeURIComponent(u.username || "postgres")
  const password = safeDecodeURIComponent(u.password || "")
  const port = Number(u.port || 5432)
  const database = (u.pathname || "/postgres").replace(/^\//, "") || "postgres"

  console.log("[db] Using IPv4", ipv4, "for Postgres host", hostname, "(avoids broken IPv6 routes to Supabase)")

  return {
    ...base,
    host: ipv4,
    port,
    user,
    password,
    database,
    ssl: useSsl
      ? { rejectUnauthorized: false, servername: hostname }
      : false,
  }
}

const pool = new Pool(await buildPoolConfig())

pool.on("connect", () => {
  console.log("[db] PostgreSQL pool connection acquired")
})

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL error:", err)
})

export default pool
