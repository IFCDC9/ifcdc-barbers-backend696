import dns from "node:dns";
import pkg from "pg";

const { Pool } = pkg;

/** Prefer IPv4 so Supabase direct hosts do not bind to unreachable IPv6 on Render. */
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

let pool = null;

function stripSslQueryFromUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return urlString;
  }
  for (const key of [
    "sslmode",
    "ssl",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    u.searchParams.delete(key);
  }
  return u.toString();
}

/**
 * Render (and many PaaS hosts) cannot reach Supabase direct `db.<ref>.supabase.co`
 * when that hostname is IPv6-only → connect ENETUNREACH :::0.
 * Transaction pooler is IPv4 and is the correct production DATABASE_URL form.
 */
function preferSupabaseTransactionPooler(raw) {
  const s = String(raw || "").trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    const host = String(u.hostname || "").toLowerCase();
    const m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (!m) return s;

    const projectRef = m[1];
    const poolerHost =
      String(process.env.SUPABASE_POOLER_HOST || "").trim() ||
      "aws-1-us-east-1.pooler.supabase.com";
    const out = new URL(`postgresql://${poolerHost}:6543/postgres`);
    out.username = `postgres.${projectRef}`;
    out.password = decodeURIComponent(u.password || "");
    out.searchParams.set("sslmode", "require");
    console.warn(
      `[db] Rewrote direct Supabase host ${host}:5432 → transaction pooler ${poolerHost}:6543 (avoids IPv6 ENETUNREACH on Render)`,
    );
    return out.toString();
  } catch {
    return s;
  }
}

function getDatabaseUrl() {
  const raw = String(process.env.DATABASE_URL || "").trim();
  if (!raw) return raw;
  const preferred = preferSupabaseTransactionPooler(raw);
  // pg will otherwise treat sslmode=require like verify-full in some setups.
  return stripSslQueryFromUrl(preferred);
}

export function getDbPool() {
  if (pool) return pool;
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL_missing");
  }
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 2),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 12_000),
  });
  return pool;
}

export async function dbQuery(text, params) {
  const p = getDbPool();
  return await p.query(text, params);
}
