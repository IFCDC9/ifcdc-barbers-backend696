import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBeautySandboxSchema,
  productionSupabaseUrl,
  ISOLATED_BEAUTY_SANDBOX_DB,
  BEAUTY_MIGRATION_FILES,
} from "../applyBeautySandboxSchema.js";

test("refuses production Supabase host without printing the URL", () => {
  assert.equal(
    productionSupabaseUrl({
      DATABASE_URL: "postgresql://u:p@db.vtkxuagevtiwtoheomjt.supabase.co:5432/postgres",
    }),
    true,
  );
  assert.equal(
    productionSupabaseUrl({
      DATABASE_URL: "postgresql://u:p@example-render-host:5432/ifcdc_beauty_sandbox_db",
    }),
    false,
  );
});

test("aborts apply on production Supabase before any SQL", async () => {
  let called = false;
  const result = await applyBeautySandboxSchema({
    query: async () => {
      called = true;
      throw new Error("should not query");
    },
    env: { DATABASE_URL: "postgresql://u:p@db.vtkxuagevtiwtoheomjt.supabase.co:5432/postgres" },
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "production_supabase_host");
  assert.equal(called, false);
});

test("skips apply when current_database is not the isolated sandbox name", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    return {
      rows: [{
        db: "postgres",
        app_users: true,
        beauty_catalog: false,
        seller_accounts: false,
        order_drafts: false,
        sandbox_orders: false,
        sandbox_refunds: false,
      }],
    };
  };
  const result = await applyBeautySandboxSchema({ query, env: { DATABASE_URL: "postgresql://u:p@localhost/postgres" } });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "wrong_database");
  assert.equal(result.inspect.currentDatabase, "postgres");
  assert.equal(calls.length, 1);
});

test("applies the five beauty SQL files only on ifcdc_beauty_sandbox_db", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    return {
      rows: [{
        db: ISOLATED_BEAUTY_SANDBOX_DB,
        app_users: true,
        beauty_catalog: true,
        seller_accounts: true,
        order_drafts: true,
        sandbox_orders: true,
        sandbox_refunds: true,
      }],
    };
  };
  const result = await applyBeautySandboxSchema({ query, env: { DATABASE_URL: "postgresql://u:p@localhost/ifcdc_beauty_sandbox_db" } });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1 + BEAUTY_MIGRATION_FILES.length + 1);
  assert.equal(calls.filter((sql) => String(sql).includes("beauty_catalog_state") || String(sql).includes("CREATE TABLE") || String(sql).includes("current_database")).length >= 2, true);
  assert.equal(result.inspect.tables.beauty_catalog, true);
});
