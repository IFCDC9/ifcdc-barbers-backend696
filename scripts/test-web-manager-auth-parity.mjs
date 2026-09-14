#!/usr/bin/env node
/**
 * Web ↔ mobile session parity + manager web-gate regression (no browser).
 *
 *   LOOKUP_EMAIL=... node --import ./loadBackendEnv.mjs scripts/test-web-manager-auth-parity.mjs
 *   MANAGER_EMAIL=... MANAGER_PASSWORD=... node --import ./loadBackendEnv.mjs scripts/test-web-manager-auth-parity.mjs
 *
 * Also unit-tests client postLoginPath / isActiveManager helpers via dynamic import.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dbQuery } from "../db.js";
import { ensureManagementTeamSchema } from "../managementTeamMigrations.js";
import {
  ensureManagementLinkedToUser,
  loadActiveManagementContext,
  managementFieldsForPublicUser,
} from "../managementTeamAuth.js";
import { SUPER_ADMIN_ONLY_CAPABILITIES, hasEffectivePermission } from "../managementPermissions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(__dirname, "../client/src/lib/staffDashboardAccess.js");
const helpers = await import(pathToFileURL(helperPath).href);

const API = String(process.env.API_ORIGIN || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/+$/,
  "",
);
const lookupEmail = String(process.env.LOOKUP_EMAIL || process.env.MANAGER_EMAIL || "laketa47@icloud.com")
  .trim()
  .toLowerCase();
const password = String(process.env.MANAGER_PASSWORD || "").trim();

await ensureManagementTeamSchema();

// --- Unit: web helpers (system-level, not Laketa-hardcoded) ---
{
  const customer = { role: "user", isManager: false };
  assert.equal(helpers.postLoginPath(customer), "/booking");
  assert.equal(helpers.isActiveManager(customer), false);
  assert.equal(helpers.canAccessShopManagement(customer), false);

  const manager = {
    role: "user",
    isManager: true,
    managementStatus: "active",
    managementRole: "shop_manager",
  };
  assert.equal(helpers.isActiveManager(manager), true);
  assert.equal(helpers.canAccessShopManagement(manager), true);
  assert.equal(helpers.isPlatformAdmin(manager), false);
  assert.equal(helpers.postLoginPath(manager), "/admin/shops");
  assert.equal(helpers.managementRoleLabel(manager), "Shop Manager");
  assert.equal(
    helpers.managementRoleLabel({ ...manager, managementRole: "platform_manager" }),
    "Platform Manager",
  );

  const suspended = { ...manager, managementStatus: "suspended" };
  assert.equal(helpers.isActiveManager(suspended), false);
  assert.equal(helpers.canAccessShopManagement(suspended), false);
  assert.equal(helpers.postLoginPath(suspended), "/booking");

  const removed = { ...manager, managementStatus: "removed", isManager: false };
  assert.equal(helpers.postLoginPath(removed), "/booking");

  const sa = { role: "super_admin", isSuperAdmin: true };
  assert.equal(helpers.postLoginPath(sa), "/admin");
  assert.equal(helpers.isPlatformAdmin(sa), true);

  console.log("[web-auth] PASS — helper routing / ACTIVE manager gates");
}

// --- DB: one account, management-aware session fields ---
{
  const users = await dbQuery(
    `SELECT id, email, role, name FROM app_users WHERE lower(trim(email)) = $1 LIMIT 3`,
    [lookupEmail],
  );
  assert.ok((users.rows || []).length === 1, "exactly one account for email");
  const u = users.rows[0];
  assert.notEqual(String(u.role).toLowerCase(), "shop_owner", "base role must not be shop_owner");

  const linked = await ensureManagementLinkedToUser({ userId: u.id, email: u.email });
  const ctx = linked || (await loadActiveManagementContext(u.id));
  const fields = managementFieldsForPublicUser(ctx);

  assert.equal(fields.isManager, true);
  assert.ok(
    ["shop_manager", "platform_manager", "location_manager"].includes(
      String(fields.managementRole || "").toLowerCase(),
    ),
    "managementRole must be a scoped manager role from DB",
  );
  assert.equal(String(fields.managementStatus || "active").toLowerCase(), "active");
  assert.ok(Array.isArray(fields.managementShopIds) && fields.managementShopIds.length >= 1);
  assert.equal(helpers.postLoginPath({ role: u.role, ...fields }), "/admin/shops");

  for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
    assert.equal(hasEffectivePermission(ctx, cap), false, `SA cap blocked: ${cap}`);
  }

  const { managerCanAccessShop } = await import("../managementTeamAuth.js");
  const other = await dbQuery(
    `SELECT id FROM businesses WHERE NOT (id = ANY($1::bigint[])) ORDER BY id DESC LIMIT 1`,
    [fields.managementShopIds],
  );
  if (other.rows?.[0]?.id) {
    assert.equal(
      managerCanAccessShop(ctx, Number(other.rows[0].id)),
      false,
      "cross-shop access must be denied",
    );
  }
  assert.equal(managerCanAccessShop(ctx, Number(fields.managementShopIds[0])), true);

  console.log(
    JSON.stringify(
      {
        email: u.email,
        baseRole: u.role,
        ...fields,
        webPostLogin: helpers.postLoginPath({ role: u.role, ...fields }),
        saCapsBlocked: true,
      },
      null,
      2,
    ),
  );
  console.log("[web-auth] PASS — DB session parity for manager");
}

// --- Live API login (optional password) ---
if (password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: lookupEmail, password }),
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `login HTTP ${res.status}`);
  assert.ok(data.token, "token issued");
  assert.ok(data.user, "user returned");
  assert.equal(data.user.isManager, true);
  assert.equal(String(data.user.role).toLowerCase(), "user");
  assert.equal(String(data.user.managementRole).toLowerCase(), String(fields.managementRole).toLowerCase());
  assert.equal(helpers.postLoginPath(data.user), "/admin/shops");

  const me = await fetch(`${API}/api/auth/me`, {
    headers: { Authorization: `Bearer ${data.token}`, Accept: "application/json" },
  });
  const meJson = await me.json();
  assert.equal(meJson.user?.isManager, true);
  assert.equal(String(meJson.user?.managementRole).toLowerCase(), String(fields.managementRole).toLowerCase());

  // Super Admin routes stay blocked server-side for managers (management-team list)
  const mt = await fetch(`${API}/api/admin/management-team`, {
    headers: { Authorization: `Bearer ${data.token}`, Accept: "application/json" },
  });
  assert.ok([401, 403].includes(mt.status), `management-team must 401/403, got ${mt.status}`);

  console.log("[web-auth] PASS — live login + /me + SA route blocked");
} else {
  console.log("[web-auth] skipped live login (set MANAGER_PASSWORD to exercise HTTP)");
}

console.log("[web-auth] ALL PASS");
process.exit(0);
