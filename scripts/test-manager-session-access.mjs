#!/usr/bin/env node
/**
 * Verify Management Team fields appear on /api/auth/me for an ACTIVE manager.
 *
 *   MANAGER_EMAIL=... MANAGER_PASSWORD=... node --import ./loadBackendEnv.mjs scripts/test-manager-session-access.mjs
 *   Or: LOOKUP_EMAIL=laketa@... node --import ./loadBackendEnv.mjs scripts/test-manager-session-access.mjs
 */
import assert from "node:assert/strict";
import { dbQuery } from "../db.js";
import { ensureManagementTeamSchema } from "../managementTeamMigrations.js";
import {
  ensureManagementLinkedToUser,
  loadActiveManagementContext,
  managementFieldsForPublicUser,
} from "../managementTeamAuth.js";

const API = String(process.env.API_ORIGIN || "https://ifcdc-barbers-backend696.onrender.com").replace(
  /\/+$/,
  "",
);
const lookupEmail = String(process.env.LOOKUP_EMAIL || process.env.MANAGER_EMAIL || "")
  .trim()
  .toLowerCase();
const password = String(process.env.MANAGER_PASSWORD || "").trim();

await ensureManagementTeamSchema();

if (lookupEmail) {
  const users = await dbQuery(
    `SELECT id, email, role, name FROM app_users WHERE lower(trim(email)) = $1 LIMIT 5`,
    [lookupEmail],
  );
  console.log(
    JSON.stringify(
      {
        lookupEmail,
        users: users.rows || [],
      },
      null,
      2,
    ),
  );
  for (const u of users.rows || []) {
    const linked = await ensureManagementLinkedToUser({ userId: u.id, email: u.email });
    const ctx = linked || (await loadActiveManagementContext(u.id));
    console.log(
      JSON.stringify(
        {
          userId: u.id,
          baseRole: u.role,
          management: managementFieldsForPublicUser(ctx),
        },
        null,
        2,
      ),
    );
  }
}

if (lookupEmail && password) {
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: lookupEmail, password }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  assert.equal(loginRes.status, 200, `login HTTP ${loginRes.status}`);
  assert.ok(loginJson.token, "login token");
  assert.equal(loginJson.user?.isManager, true, "login user.isManager");
  assert.ok(loginJson.user?.managementRole, "login managementRole");
  assert.equal(String(loginJson.user?.role || "").toLowerCase() === "shop_owner", false);

  const meRes = await fetch(`${API}/api/auth/me`, {
    headers: { Authorization: `Bearer ${loginJson.token}` },
  });
  const meJson = await meRes.json().catch(() => ({}));
  assert.equal(meRes.status, 200, `me HTTP ${meRes.status}`);
  assert.equal(meJson.user?.isManager, true, "/me must return isManager");
  assert.ok(Array.isArray(meJson.user?.managementShopIds), "managementShopIds");
  assert.equal(meJson.user?.fullManagerAccess === true || meJson.user?.managerPermissions?.full_manager_access === true, true);
  console.log(
    JSON.stringify(
      {
        liveApi: true,
        loginIsManager: loginJson.user?.isManager,
        meIsManager: meJson.user?.isManager,
        managementRole: meJson.user?.managementRole,
        shopIds: meJson.user?.managementShopIds,
        baseRole: meJson.user?.role,
        fullManagerAccess: meJson.user?.fullManagerAccess,
      },
      null,
      2,
    ),
  );
  console.log("[manager-session] PASS");
} else if (!lookupEmail) {
  console.log("[manager-session] skipped (set LOOKUP_EMAIL or MANAGER_EMAIL)");
} else {
  console.log("[manager-session] DB linkage printed; set MANAGER_PASSWORD for live /me check");
}
