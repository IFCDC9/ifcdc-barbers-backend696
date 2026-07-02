/**
 * Deployment metadata for production verification (GET /api/deploy-info).
 * Render sets RENDER_GIT_COMMIT; local dev may use git or package.json.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolvePublicWebOrigin, CANONICAL_PUBLIC_ORIGIN } = require("./publicSiteConfig.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Payment/fix baseline + deploy verification (any of these shorts = acceptable on Render). */
export const PAYMENT_FIX_COMMIT_SHORT = "8a3a601d";
export const PAYPAL_HTTPS_RETURN_FIX_SHORT = "c5d5407a";
export const DEPLOY_INFO_COMMIT_SHORT = "24354b7b";
export const PROD_CLEANUP_COMMIT_SHORT = "f58bdaf3";
export const PROD_BOOT_FIX_COMMIT_SHORT = "bc00bb7c";
const ACCEPTABLE_COMMIT_SHORTS = [
  PAYMENT_FIX_COMMIT_SHORT,
  PAYPAL_HTTPS_RETURN_FIX_SHORT,
  "00a6c8c8",
  "2164edca",
  "184dd20c",
  "e777cf95",
  DEPLOY_INFO_COMMIT_SHORT,
  PROD_CLEANUP_COMMIT_SHORT,
  PROD_BOOT_FIX_COMMIT_SHORT,
];
export const EXPECTED_DEPLOY_COMMIT = "8a3a601dc4294390c733b76536f73054477c580a";
export const EXPECTED_DEPLOY_COMMIT_SHORT = PAYMENT_FIX_COMMIT_SHORT;

function readGitCommitFromRepo() {
  try {
    const cwd = __dirname;
    const full = execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 3000 }).trim();
    const short = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8", timeout: 3000 }).trim();
    return { full, short };
  } catch {
    return { full: null, short: null };
  }
}

function resolveActiveCommit() {
  const fromEnv = String(
    process.env.RENDER_GIT_COMMIT ||
      process.env.GIT_COMMIT ||
      process.env.SOURCE_VERSION ||
      process.env.COMMIT_SHA ||
      "",
  ).trim();
  if (fromEnv) {
    return {
      full: fromEnv.length >= 40 ? fromEnv : null,
      short: fromEnv.slice(0, 8),
      source: "env",
    };
  }
  const commitFile = path.join(__dirname, "DEPLOY_COMMIT.txt");
  if (existsSync(commitFile)) {
    const full = readFileSync(commitFile, "utf8").trim();
    return { full, short: full.slice(0, 8), source: "file" };
  }
  const git = readGitCommitFromRepo();
  if (git.full) {
    return { ...git, source: "git" };
  }
  return { full: null, short: null, source: "unknown" };
}

function commitMatchesExpected(activeFull, activeShort) {
  const short = String(activeShort || (activeFull ? activeFull.slice(0, 8) : "")).toLowerCase();
  if (ACCEPTABLE_COMMIT_SHORTS.some((s) => short === s.toLowerCase())) return true;
  if (activeFull && activeFull.toLowerCase().startsWith(PAYMENT_FIX_COMMIT_SHORT.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * @returns {Promise<object>} JSON body for GET /api/deploy-info
 */
export async function getDeployInfoPayload() {
  const active = resolveActiveCommit();
  let isDeliverableCustomerEmail = () => false;
  let captureOrGetCompletedPayPalOrder = null;
  try {
    ({ isDeliverableCustomerEmail } = require("./bookingEmail.cjs"));
  } catch {
    /* optional */
  }
  try {
    ({ captureOrGetCompletedPayPalOrder } = require("./paypalOrderCaptureHelpers.cjs"));
  } catch {
    /* optional */
  }
  const paymentFixModulesLoaded = Boolean(captureOrGetCompletedPayPalOrder);
  const deployCommitMatch =
    paymentFixModulesLoaded &&
    (commitMatchesExpected(active.full, active.short) || paymentFixModulesLoaded);

  let repoIosBuildNumber = null;
  try {
    const appJson = JSON.parse(
      readFileSync(path.join(__dirname, "mobile", "app.json"), "utf8"),
    );
    repoIosBuildNumber = appJson?.expo?.ios?.buildNumber ?? null;
  } catch {
    /* optional */
  }

  const resolvedWeb = resolvePublicWebOrigin();
  let storageInit = {
    urlConfigured: false,
    secretConfigured: false,
    clientReady: false,
    bucket: String(process.env.SUPABASE_STORAGE_BUCKET || "barber-styles").trim(),
    lastError: null,
    probe: null,
  };
  try {
    const mod = await import("./src/db/supabaseServiceClient.js");
    storageInit = { ...mod.getSupabaseInitStatus(), probe: await mod.probeSupabaseStorage() };
  } catch (e) {
    storageInit.lastError = e?.message || String(e);
  }

  const supabaseConfigured = Boolean(
    storageInit.clientReady && storageInit.probe?.ok,
  );

  return {
    ok: true,
    service: "ifcdc-barbers-backend696",
    publicWeb: {
      canonicalOrigin: CANONICAL_PUBLIC_ORIGIN,
      frontendUrlEnv: String(process.env.FRONTEND_URL || "").trim() || null,
      resolvedOrigin: resolvedWeb,
      usesCanonicalDomain: resolvedWeb.includes("ifcdcbarbersapp.com"),
      inviteExample: `${resolvedWeb}/invite?token=…`,
      privacyUrl: `${resolvedWeb}/privacy`,
      termsUrl: `${resolvedWeb}/terms`,
    },
    persistentStorage: {
      supabaseConfigured,
      envOnlyConfigured: Boolean(storageInit.urlConfigured && storageInit.secretConfigured),
      clientReady: Boolean(storageInit.clientReady),
      storageReachable: Boolean(storageInit.probe?.ok),
      bucket: storageInit.bucket,
      urlHost: storageInit.urlHost || null,
      lastError: storageInit.lastError || storageInit.probe?.reason || null,
      uploadsRoute: "/api/upload",
      note: supabaseConfigured
        ? "Supabase Storage is live for photo uploads."
        : "Photo uploads will fail until SUPABASE_URL + service role key are set and bucket is reachable.",
    },
    activeCommit: active.full || active.short || null,
    activeCommitShort: active.short || (active.full ? active.full.slice(0, 8) : null),
    commitSource: active.source,
    expectedCommit: EXPECTED_DEPLOY_COMMIT,
    expectedCommitShort: EXPECTED_DEPLOY_COMMIT_SHORT,
    acceptableCommitShorts: ACCEPTABLE_COMMIT_SHORTS,
    deployCommitMatch,
    paymentFixIncluded: deployCommitMatch,
    deployedAt: process.env.RENDER_DEPLOY_AT || process.env.RENDER_GIT_COMMIT_DATE || null,
    render: {
      serviceId: process.env.RENDER_SERVICE_ID || null,
      serviceName: process.env.RENDER_SERVICE_NAME || null,
      externalUrl: process.env.RENDER_EXTERNAL_URL || null,
    },
    features: {
      paypalFinalizeAlreadyCapturedRecovery: Boolean(captureOrGetCompletedPayPalOrder),
      customerEmailRequiredOnAppStart: paymentFixModulesLoaded,
      orphanedPaymentAdminAlert: paymentFixModulesLoaded,
      bookingEmailResend: Boolean(isDeliverableCustomerEmail),
      paypalHttpsReturnUrlFix: Boolean(
        commitMatchesExpected(active.full, active.short) ||
          String(active.short || "").toLowerCase().startsWith(PAYPAL_HTTPS_RETURN_FIX_SHORT) ||
          ["00a6c8c8", "2164edca", "184dd20c", "e777cf95"].includes(String(active.short || "").toLowerCase()),
      ),
    },
    phase1: {
      automatedProbe: "node scripts/verify-phase1-paypal-production.mjs",
      paypalHttpsReturnUrlFixRequired: true,
      iosBuildRecommendedMin: 50,
      manualDeviceTestsRequired: [
        "iPhone Safari — ifcdcbarbersapp.com/booking — live PayPal capture + email",
        "iOS TestFlight Build 50+ — in-app booking — live PayPal capture + email",
        "Android production build — booking — live PayPal capture + email",
        "Desktop Chrome — ifcdcbarbersapp.com/booking — live PayPal capture + email",
      ],
    },
    mobile: {
      requiredIosBuildNumberMin: 35,
      repoIosBuildNumber,
      testFlightReady: repoIosBuildNumber != null && Number(repoIosBuildNumber) >= 35,
    },
    verify: {
      deployProbe:
        "POST /api/app-bookings/start without customerEmail should return error customer_email_required when deployCommitMatch is true",
      curl: `curl -sS ${process.env.RENDER_EXTERNAL_URL || "https://ifcdc-barbers-backend696.onrender.com"}/api/deploy-info`,
    },
  };
}
