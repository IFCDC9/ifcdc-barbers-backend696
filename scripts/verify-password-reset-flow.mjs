#!/usr/bin/env node
/**
 * Verify public password reset API (app_users + Resend, not Supabase Auth).
 *
 * Usage:
 *   node scripts/verify-password-reset-flow.mjs
 *   API_BASE=https://ifcdc-barbers-backend696.onrender.com node scripts/verify-password-reset-flow.mjs
 *
 * Optional full E2E (requires existing account + inbox access):
 *   TEST_RESET_EMAIL=you@example.com TEST_RESET_PASSWORD='NewSecurePass1!' node --import ./loadBackendEnv.mjs scripts/verify-password-reset-flow.mjs --e2e
 */
import "../loadBackendEnv.mjs";
import crypto from "node:crypto";
import pg from "pg";
import { createRequire } from "node:module";
import {
  completePasswordResetWithToken,
  requestPasswordResetForEmail,
} from "../passwordResetService.js";

const require = createRequire(import.meta.url);
const { CANONICAL_PUBLIC_ORIGIN, buildPasswordResetUrl } = require("../publicSiteConfig.cjs");

const API_BASE = String(process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(/\/$/, "");
const e2e = process.argv.includes("--e2e");
const testEmail = String(process.env.TEST_RESET_EMAIL || "").trim().toLowerCase();
const testNewPassword = String(process.env.TEST_RESET_PASSWORD || "").trim();

let passed = 0;
let failed = 0;

function pass(label, detail = "") {
  passed++;
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failed++;
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function stripSsl(url) {
  return url.replace(/[?&]sslmode=[^&]*/g, "").replace(/[?&]ssl=[^&]*/g, "");
}

async function localServiceE2E() {
  const url = stripSsl(String(process.env.DATABASE_URL || ""));
  if (!url) {
    fail("local e2e", "DATABASE_URL missing");
    return;
  }
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const sendEmail = async () => ({ ok: true });

  try {
    const token = crypto.randomBytes(16).toString("hex");
    const email = `pwreset-${token}@ifcdc-test.invalid`;
    const initialPassword = "InitialPass123!";
    const newPassword = "UpdatedPass456!";

    const { hashPassword } = await import("../authPasswordPolicy.js");
    const passwordHash = await hashPassword(initialPassword);
    const ins = await pool.query(
      `INSERT INTO app_users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'user')
       RETURNING id`,
      ["Reset Test", email, passwordHash],
    );
    const userId = ins.rows[0].id;

    const req = await requestPasswordResetForEmail(email, { sendEmail });
    if (!req.ok || !req.sent) {
      fail("local service request", JSON.stringify(req));
    } else {
      pass("local service issues token");
    }

    const expectedOrigin = CANONICAL_PUBLIC_ORIGIN.replace(/\/$/, "");
    if (req.resetLink?.startsWith(`${expectedOrigin}/reset-password?token=`)) {
      pass("reset link uses frontend origin", expectedOrigin);
    } else if (req.resetLink?.includes("backend696") || req.resetLink?.includes("onrender.com/api")) {
      fail("reset link must not point at API host", req.resetLink);
    } else {
      fail("reset link format", req.resetLink || "(missing)");
    }

    const sample = buildPasswordResetUrl("sample-token");
    if (sample.startsWith(`${expectedOrigin}/reset-password?`)) {
      pass("buildPasswordResetUrl uses SPA origin");
    } else {
      fail("buildPasswordResetUrl", sample);
    }

    const row = await pool.query(
      `SELECT reset_token_hash FROM app_users WHERE id = $1::uuid`,
      [userId],
    );
    if (!row.rows[0]?.reset_token_hash) {
      fail("local service token stored");
    } else {
      pass("local service token stored in app_users");
    }

    const rawToken = req.resetLink?.match(/token=([^&]+)/)?.[1];
    if (!rawToken) {
      fail("local service reset link");
    } else {
      const done = await completePasswordResetWithToken(decodeURIComponent(rawToken), newPassword);
      if (!done.ok) {
        fail("local service complete reset", done.message);
      } else {
        pass("local service completes reset");
      }
    }

    const loginRes = await postJson("/api/auth/login", { email, password: newPassword });
    if (loginRes.status === 200 && loginRes.json?.token) {
      pass("local service login with new password");
    } else {
      fail("local service login with new password", `HTTP ${loginRes.status}`);
    }

    await pool.query(`DELETE FROM app_users WHERE id = $1::uuid`, [userId]);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`\n=== Password reset verification ===\nAPI: ${API_BASE}\n`);

  const WEB = String(process.env.FRONTEND_URL || "https://ifcdcbarbersapp.com").replace(/\/$/, "");

  const health = await fetch(`${API_BASE}/api/health`);
  if (health.ok) pass("API health");
  else fail("API health", `HTTP ${health.status}`);

  const resetPage = await fetch(`${WEB}/reset-password?token=e2e-test-token`);
  if (resetPage.ok) {
    const html = await resetPage.text();
    if (html.includes("Create New Password") || html.includes("New Password") || html.includes("root")) {
      pass("SPA serves /reset-password", WEB);
    } else {
      fail("SPA /reset-password body", "expected React shell");
    }
  } else {
    fail("SPA /reset-password", `HTTP ${resetPage.status}`);
  }

  const badEmail = await postJson("/api/auth/forgot-password", { email: "" });
  if (badEmail.status === 400) pass("forgot-password rejects empty email");
  else fail("forgot-password rejects empty email", `HTTP ${badEmail.status}`);

  const unknown = await postJson("/api/auth/forgot-password", {
    email: `no-such-user-${Date.now()}@ifcdc-test.invalid`,
  });
  if (unknown.status === 200 && unknown.json?.success) {
    pass("forgot-password neutral success for unknown email");
  } else {
    fail("forgot-password neutral success", `HTTP ${unknown.status} ${JSON.stringify(unknown.json)}`);
  }

  const badToken = await postJson("/api/auth/reset-password", {
    token: "not-a-real-token",
    newPassword: "ValidPass123!@",
  });
  if (badToken.status === 400 && badToken.json?.error === "invalid_token") {
    pass("reset-password rejects invalid token");
  } else {
    fail("reset-password rejects invalid token", `HTTP ${badToken.status}`);
  }

  const weak = await postJson("/api/auth/reset-password", {
    token: "abcd",
    newPassword: "short",
  });
  if (weak.status === 400) pass("reset-password rejects weak password");
  else fail("reset-password rejects weak password", `HTTP ${weak.status}`);

  const forgotRoute = await postJson("/api/auth/forgot-password", { email: "not-an-email" });
  if (forgotRoute.status === 400) pass("forgot-password rejects invalid format");
  else if (forgotRoute.status === 500) {
    fail("forgot-password still returns 500 (deploy password-reset fix)", JSON.stringify(forgotRoute.json));
  } else {
    pass("forgot-password handles invalid format", `HTTP ${forgotRoute.status}`);
  }

  if (e2e && testEmail && testNewPassword) {
    console.log("\n--- E2E (production API + DB token) ---\n");
    const forgot = await postJson("/api/auth/forgot-password", { email: testEmail });
    if (forgot.status === 200) pass("E2E forgot-password accepted");
    else fail("E2E forgot-password", `HTTP ${forgot.status}`);

    const url = stripSsl(String(process.env.DATABASE_URL || ""));
    if (url) {
      const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
      try {
        const r = await pool.query(
          `SELECT reset_token_hash FROM app_users WHERE lower(trim(email::text)) = $1 LIMIT 1`,
          [testEmail],
        );
        if (r.rows[0]?.reset_token_hash) pass("E2E reset token stored in app_users");
        else fail("E2E reset token stored", "check TEST_RESET_EMAIL exists in app_users");
      } finally {
        await pool.end();
      }
    }
    console.log("Check inbox for reset link → https://ifcdcbarbersapp.com/reset-password?token=…");
  }

  await localServiceE2E();

  console.log(`\n--- Summary ---\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
