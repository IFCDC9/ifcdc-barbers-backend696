import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbQuery } from "./db.js";

export const ISOLATED_BEAUTY_SANDBOX_DB = "ifcdc_beauty_sandbox_db";
export const PRODUCTION_SUPABASE_REF = "vtkxuagevtiwtoheomjt";

export const BEAUTY_MIGRATION_FILES = [
  "beauty-catalog.sql",
  "beauty-seller-payment-accounts.sql",
  "beauty-order-drafts.sql",
  "beauty-sandbox-checkout.sql",
  "beauty-sandbox-operations.sql",
];

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export function productionSupabaseUrl(env = process.env) {
  const raw = String(env.DATABASE_URL || "").trim();
  if (!raw) return false;
  try {
    return String(new URL(raw).hostname || "")
      .toLowerCase()
      .includes(PRODUCTION_SUPABASE_REF);
  } catch {
    return raw.toLowerCase().includes(PRODUCTION_SUPABASE_REF);
  }
}

export async function inspectBeautySandboxDb(query = dbQuery) {
  const r = await query(`SELECT
    current_database() AS db,
    to_regclass('public.app_users') IS NOT NULL AS app_users,
    to_regclass('public.beauty_catalog_state') IS NOT NULL AS beauty_catalog,
    to_regclass('public.beauty_seller_payment_accounts') IS NOT NULL AS seller_accounts,
    to_regclass('public.beauty_order_drafts') IS NOT NULL AS order_drafts,
    to_regclass('public.beauty_sandbox_orders') IS NOT NULL AS sandbox_orders,
    to_regclass('public.beauty_sandbox_refunds') IS NOT NULL AS sandbox_refunds`);
  const row = r.rows?.[0] || {};
  const currentDatabase = String(row.db || "");
  return {
    currentDatabase,
    isolatedDbMatch: currentDatabase === ISOLATED_BEAUTY_SANDBOX_DB,
    tables: {
      app_users: Boolean(row.app_users),
      beauty_catalog: Boolean(row.beauty_catalog),
      seller_accounts: Boolean(row.seller_accounts),
      order_drafts: Boolean(row.order_drafts),
      sandbox_orders: Boolean(row.sandbox_orders),
      sandbox_refunds: Boolean(row.sandbox_refunds),
    },
  };
}

export async function applyBeautySandboxSchema({
  query = dbQuery,
  env = process.env,
  root = repoRoot,
} = {}) {
  if (productionSupabaseUrl(env)) {
    console.error("[beauty-schema] ABORT: DATABASE_URL host is production Supabase");
    return { applied: false, reason: "production_supabase_host" };
  }
  let inspect;
  try {
    inspect = await inspectBeautySandboxDb(query);
  } catch (e) {
    console.error("[beauty-schema] inspect failed:", e?.message || e);
    return { applied: false, reason: "inspect_failed" };
  }
  if (!inspect.isolatedDbMatch) {
    console.warn(
      "[beauty-schema] skip apply; current_database is not",
      ISOLATED_BEAUTY_SANDBOX_DB,
    );
    return { applied: false, reason: "wrong_database", inspect };
  }
  const dir = path.join(root, "scripts", "migrations");
  for (const file of BEAUTY_MIGRATION_FILES) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await query(sql);
    console.log("[beauty-schema] applied", file);
  }
  return { applied: true, inspect: await inspectBeautySandboxDb(query) };
}
