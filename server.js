/**
 * IFCDC Barbers API — ESM entry (`"type": "module"`).
 * `./loadBackendEnv.mjs` MUST stay first — loads `backend/.env` (absolute path) before other imports run.
 */
import "./loadBackendEnv.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import { createRequire } from "module";
import express from "express";
import session from "express-session";
import { mountProductionBarbersRoutes } from "./productionBarbersRoutes.js";
import { mountProductionCms } from "./mountProductionCms.js";
import { createAuthRouter, resolveAuthPayload } from "./authRoutes.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import {
  ensureUsersRoleColumn,
  ensureGoogleAuthSupport,
  ensureAppleAuthSupport,
  ensurePendingInvitesTable,
  ensurePasswordRecoveryColumns,
} from "./authDbMigrations.js";
import { ensureInitialSuperAdmin } from "./seedSuperAdmin.js";
import { ensureStylesTables, seedSampleStylesIfEmpty } from "./stylesMigrations.js";
import { createStylesRouter } from "./stylesRoutes.js";
import { ensureBookingsTable } from "./bookingsMigrations.js";
import { ensureBarberBusinessTables } from "./barberBusinessMigrations.js";
import { createBarberBusinessRouter } from "./barberBusinessRoutes.js";
import { ensureBookingStatusHistoryTable } from "./bookingStatusEngine.js";
import { ensurePushNotificationsSchema } from "./pushNotificationsMigrations.js";
import { createNotificationRouter } from "./notificationRoutes.js";
import { ensureLegalAcceptanceSchema } from "./legalAcceptanceMigrations.js";
import { createLegalRouter } from "./legalRoutes.js";
import { mountBarberOnboardingRoutes } from "./barberOnboardingRoutes.js";
import { mountOnboardingBusinessRoutes } from "./onboardingBusinessRoutes.js";
import { handleBarberAvailableSlotsGet } from "./barberAvailableSlotsRoute.js";
import { createBookingsRouter, insertAuraVoiceBookingRow } from "./bookingsRoutes.js";
import { createManualBypassBookingRouter } from "./manualBypassBookingRoutes.js";
import { ensureManualBypassBookingColumns } from "./manualBypassBookingMigrations.js";
import { createBookingsAdminGuard } from "./bookingsAdminGuard.js";
import { createAdminUsersRouter } from "./adminUsersRoutes.js";
import { createAdminBarbersRouter } from "./adminBarbersRoutes.js";
import { createSocialPortfolioRouter } from "./socialPortfolioRoutes.js";
import { ensureSocialPortfolioSchema } from "./socialPortfolioMigrations.js";
import { createLoyaltyRouter } from "./loyaltyRoutes.js";
import { ensureLoyaltySchema } from "./loyaltyMigrations.js";
import { expireStaleRewardReservations, seedDefaultRewardsIfEmpty } from "./loyaltyService.js";
import { createHubSpotRouter } from "./hubspotRoutes.js";
import { ensureHubSpotSchema } from "./hubspotMigrations.js";
import { createAdminShopsRouter } from "./adminShopsRoutes.js";
import { createAdminHubSpotRouter } from "./adminHubspotRoutes.js";
import { ensureAdminBarberManagementSchema } from "./adminBarberMigrations.js";
import { ensureProviderTypeSchema } from "./providerTypeMigrations.js";
import { ensurePreferredLanguageSchema } from "./preferredLanguageMigrations.js";
import { ensureAppUsersBarberIdTypeAligned } from "./authDbMigrations.js";
import { backfillOrphanBarberRegistrations } from "./signupProvisioningService.js";
import { ensureAdminShopManagementSchema } from "./adminShopMigrations.js";
import { dbQuery } from "./db.js";
import { resolvePublicBusinessPhone } from "./src/services/publicContactConfig.js";
import { ensureSecurityAuditTable, ensureSecurityTenantColumns } from "./securityTenantMigrations.js";
import {
  auraUnclearFallbackReply,
  auraStructuredIntentFromKeywords,
  auraKeywordFallbackReply,
} from "./auraIntent.js";
import {
  auraChatNavigateBook,
  auraChatNavigateStylesSuffix,
  detectClientLanguage,
  normalizeBarberLang,
  openAiLanguageInstruction,
  resolveAuraLanguage,
} from "./auraLocale.js";
import { loadBarberSettingsRow } from "./barberScope.js";
import { barberAuraEffective } from "./subscriptionTier.js";
import { auraFetchStyleTitles } from "./auraData.js";
import { attachAuraVoiceRoutes, attachAuraSmsWebhook } from "./auraVoiceRoutes.js";
import { getPublicApiBaseUrl } from "./auraVoiceReply.js";
import { ssmlThanksCallingOpener } from "./auraVoiceSsml.js";
import { handleTwilioSmsStatusCallback } from "./voiceBookingSms.js";
import { ensureAuraMemoryTables } from "./auraMemoryMigrations.js";
import { createAuraChatHistoryRouter } from "./auraChatHistoryRoutes.js";
import { requireAuth } from "./authRoutes.js";
import { getDeployInfoPayload } from "./deployInfo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripOuterQuotes(s) {
  let t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

console.log("ENV CHECK:");
console.log("PUBLIC_API_URL =", process.env.PUBLIC_API_URL ?? "(undefined)");
console.log("PUBLIC_BASE_URL =", process.env.PUBLIC_BASE_URL ?? "(undefined)");
console.log("RENDER_EXTERNAL_URL =", process.env.RENDER_EXTERNAL_URL ?? "(undefined)");

/**
 * Public HTTPS origin for Twilio webhooks and absolute links (no trailing slash).
 * Render sets RENDER_EXTERNAL_URL; many dashboards use PUBLIC_BASE_URL instead.
 */
function resolvePublicApiBase() {
  const candidates = [
    ["PUBLIC_API_URL", process.env.PUBLIC_API_URL],
    ["PUBLIC_BASE_URL", process.env.PUBLIC_BASE_URL],
    ["RENDER_EXTERNAL_URL", process.env.RENDER_EXTERNAL_URL],
    ["TWILIO_PUBLIC_BASE_URL", process.env.TWILIO_PUBLIC_BASE_URL],
  ];
  for (const [name, raw] of candidates) {
    const v = stripOuterQuotes(raw);
    if (!v) continue;
    const base = v.replace(/\/$/, "");
    if (base) return { base, source: name };
  }
  return { base: "", source: null };
}

const { base: BASE_URL, source: publicBaseSource } = resolvePublicApiBase();
if (!BASE_URL) {
  console.error("❌ PUBLIC_API_URL NOT LOADED (no public base URL resolved)");
  console.error(
    "Set one of: PUBLIC_API_URL, PUBLIC_BASE_URL, RENDER_EXTERNAL_URL (automatic on Render), or TWILIO_PUBLIC_BASE_URL — https URL, no trailing slash.",
  );
  process.exit(1);
}

process.env.PUBLIC_API_URL = BASE_URL;
if (!stripOuterQuotes(process.env.PUBLIC_BASE_URL)) {
  process.env.PUBLIC_BASE_URL = BASE_URL;
}
console.log(`✅ AURA BASE URL (${publicBaseSource}):`, BASE_URL);

const twilioMsSid = stripOuterQuotes(process.env.TWILIO_MESSAGING_SERVICE_SID || "").replace(/\s/g, "");
process.env.TWILIO_MESSAGING_SERVICE_SID = twilioMsSid;
console.log("📡 USING SERVICE SID (normalized):", twilioMsSid);
console.log("📎 SMS status callback (set in Twilio Messaging Service → Integration):", `${BASE_URL}/api/sms/status`);

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

const PORT = process.env.PORT || 10000;

console.log("🚀 Server running on port:", PORT);
console.log("🌐 PUBLIC API URL:", process.env.PUBLIC_API_URL);

const AURA_NUMBER = process.env.AURA_PHONE_NUMBER;
const BUSINESS_PHONE = String(process.env.BUSINESS_PHONE || "").trim();

console.log("RESEND_API_KEY:", process.env.RESEND_API_KEY ? "LOADED" : "MISSING");
console.log("MAIL_FROM:", process.env.MAIL_FROM);
console.log(
  "PAYPAL:",
  process.env.PAYPAL_CLIENT_ID ? "PAYPAL_CLIENT_ID=set" : "PAYPAL_CLIENT_ID=missing",
  process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_SECRET
    ? "PAYPAL_CLIENT_SECRET/PAYPAL_SECRET=set"
    : "secret=missing",
  "PAYPAL_ENV=",
  process.env.PAYPAL_ENV || process.env.PAYPAL_MODE || "(default sandbox)",
);
{
  const { getPayPalHealthDiagnostics } = createRequire(import.meta.url)("./paypalEnv.cjs");
  void getPayPalHealthDiagnostics()
    .then((paypal) => {
      if (paypal.alignment?.ok) {
        console.log("[paypal] Startup OAuth OK —", paypal.environment, "token generation succeeded");
      } else {
        console.error("[paypal] Startup OAuth FAILED:", paypal.alignment?.message || paypal.oauth?.error);
        if (paypal.credentialMode && paypal.credentialMode !== paypal.environment) {
          console.error(
            `[paypal] Fix Render: set PAYPAL_ENV=${paypal.credentialMode} (credentials are ${paypal.credentialMode}, not ${paypal.environment})`,
          );
        }
      }
    })
    .catch((e) => console.error("[paypal] Startup diagnostics error:", e?.message || e));
}
console.log(
  "BUSINESS_PHONE:",
  BUSINESS_PHONE ? "set" : "unset (shop DB phone or none)",
  "AURA_PHONE_NUMBER:",
  AURA_NUMBER ? "set" : "missing",
  "OPENAI_API_KEY:",
  process.env.OPENAI_API_KEY ? "set" : "missing",
  "PUBLIC_API_URL:",
  BASE_URL,
);

const AURA_ASSISTANT_PROMPT =
  "You are AURA, the IFCDC Barbers digital receptionist. Help customers with shop hours, location, haircut services, booking appointments, pricing guidance, and appointment questions. Be concise, warm, and professional. Guide users to the Book tab to schedule. Never describe yourself as AI. Never mention internal errors or API details. Never issue refunds, change prices, delete records, or alter admin permissions — escalate those to Super Admin.";

const AURA_FAILSAFE_REPLY =
  "AURA is temporarily reconnecting. Please try again in a moment.";

/** Standard JSON body for all AURA chat routes. */
function auraChatJson(reply, action = "NONE", meta = null) {
  const message = String(reply || AURA_FAILSAFE_REPLY).trim();
  const body = { success: true, message, reply: message, action };
  if (meta && typeof meta === "object") {
    if (meta.language) body.language = String(meta.language);
    if (meta.replyLanguage) body.reply_language = String(meta.replyLanguage);
    if (typeof meta.adminMessageEn === "string") body.admin_message_en = meta.adminMessageEn;
    if (typeof meta.originalMessage === "string") body.original_message = meta.originalMessage;
  }
  return body;
}

/** JSON for GET /api/aura/status (no secrets). */
function auraStatusPayload() {
  const wiz = String(process.env.AURA_VOICE_WIZARD || "").trim() === "1";
  const pub = getPublicApiBaseUrl();
  let intelligencePhase1 = false;
  try {
    intelligencePhase1 = require("./auraVoiceIntelligenceFlags.cjs").isAuraVoiceIntelligencePhase1();
  } catch {
    intelligencePhase1 = false;
  }
  return {
    ok: true,
    voice: {
      mode: wiz ? "wizard" : "simple",
      paths: wiz
        ? ["/api/aura/voice", "/api/aura/voice/incoming"]
        : ["/api/aura/voice", "/api/aura/voice/incoming", "/api/aura/process"],
      diagnostic: {
        testRoute: "GET /api/aura/test",
        voiceDiagnosticEnv: String(process.env.AURA_VOICE_DIAGNOSTIC || "").trim() === "1",
        testResponseEnv: String(process.env.AURA_VOICE_TEST_RESPONSE || "").trim() === "1",
      },
      intelligencePhase1,
      publicBaseUrlConfigured: Boolean(pub),
      webhookBaseUrl: pub || null,
      twilioWebhookUrl: pub ? `${pub}/api/aura/voice` : null,
      gatherActionUrl: pub ? `${pub}/api/aura/voice` : null,
      processUrl: !wiz && pub ? `${pub}/api/aura/process` : null,
    },
    chat: {
      paths: ["/api/aura", "/api/aura/chat", "/api/ai/chat"],
      path: "/api/aura/chat",
      openai: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
      freeTierBypass: String(process.env.AURA_ALLOW_FREE_TIER_CHAT || "").trim() === "1",
    },
    twilio: {
      accountConfigured: Boolean(
        String(process.env.TWILIO_ACCOUNT_SID || "").trim() && String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
      ),
      messagingServiceConfigured: Boolean(String(process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim()),
      /** Voice “Call Now” outbound caller ID — not used for SMS (Messaging Service only). */
      voiceCallerIdConfigured: Boolean(String(process.env.TWILIO_PHONE_NUMBER || "").trim()),
      auraPhoneConfigured: Boolean(String(process.env.AURA_PHONE_NUMBER || "").trim()),
    },
  };
}

/** Last user text for intent routing (prefer latest `messages` entry). */
function auraLastUserText(body) {
  const { message, messages } = body || {};
  if (Array.isArray(messages) && messages.length) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "user" && String(m.content ?? "").trim()) return String(m.content).trim();
    }
  }
  return String(message || "").trim();
}

async function auraOpenAiChat({ apiKey, model, systemPrompt, thread }) {
  console.log("[aura/chat] OpenAI request sent", { model, turns: thread.length });
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...thread],
      max_tokens: 900,
      temperature: 0.65,
    }),
  });
  const data = await r.json().catch(() => ({}));
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!r.ok || !reply) {
    const errMsg = data.error?.message || `OpenAI HTTP ${r.status}`;
    console.error("[aura/chat] OpenAI response error:", errMsg);
    return { ok: false, reply: AURA_FAILSAFE_REPLY };
  }
  console.log("[aura/chat] OpenAI response received", { chars: reply.length });
  return { ok: true, reply };
}

const require = createRequire(import.meta.url);
const twilio = require("twilio");
const {
  getResend,
  getMailFrom,
  logResendProductionEnv,
  verifyResendApiKey,
  sendEmail,
} = require("./emailResend.cjs");
const { handlePaypalWebhookEvent } = require("./paypalWebhookEmail.cjs");
const { logResendStatus } = require("./bookingEmail.cjs");
const paypalPaymentRoutes = require("./paypalPaymentRoutes.cjs");
const appBookingCheckoutRoutes = require("./appBookingCheckoutRoutes.cjs");

logResendProductionEnv();
logResendStatus();

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

globalThis.__ifcdcTwilioClient = twilioClient;

/** E.164 for Twilio `calls.create` — US 10-digit → +1…; otherwise require leading +. */
function normalizeOutboundTo(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8) return `+${digits}`;
  return "";
}

/** Twilio fetches this URL over the public internet — set PUBLIC_API_URL (or ngrok) + path /voice. */
function resolveVoiceTwimlUrl() {
  const explicit = String(process.env.TWILIO_VOICE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const base = String(
    process.env.PUBLIC_API_URL || process.env.TWILIO_PUBLIC_BASE_URL || ""
  ).trim();
  if (!base) return "";
  return `${base.replace(/\/$/, "")}/voice`;
}

/** Inline TwiML when no public URL — Twilio accepts `twiml` instead of `url` (no ngrok required). */
function defaultOutboundCallTwiml() {
  const custom = String(process.env.TWILIO_CALL_TWIML || "").trim();
  if (custom) return custom;
  const greet = ssmlThanksCallingOpener("en");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Ivy" language="en-US">${greet}</Say></Response>`;
}

const app = express();
/** Correct `req.protocol` / client IP behind ngrok, Render, or other reverse proxies (needed for Twilio Gather action URLs). */
app.set("trust proxy", 1);

app.use(cors({ origin: "*" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * Summarize routes on the auth router (for production boot logs).
 */
function summarizeAuthRouterPaths(router) {
  const out = [];
  for (const layer of router?.stack || []) {
    const r = layer?.route;
    if (!r?.path) continue;
    const methods = r.methods || {};
    for (const verb of Object.keys(methods)) {
      if (methods[verb]) out.push(`${verb.toUpperCase()} /api/auth${r.path}`);
    }
  }
  return out;
}

// Auth (JWT + password reset via Resend) — mount early, before other `/api/*` routers and the JSON 404.
const authRouter = createAuthRouter({ sendEmail });
app.use("/api/aura", createAuraChatHistoryRouter({ requireAuth }));
console.log("[boot] mounted /api/aura/messages (GET, DELETE)");
// Explicit surface: some deployments/proxies mis-handle nested GET registration; this always reaches `router.get("/me", …)`.
app.get("/api/auth/me", (req, res, next) => {
  const saved = req.url;
  const q = saved.includes("?") ? saved.slice(saved.indexOf("?")) : "";
  req.url = `/me${q}`;
  authRouter.handle(req, res, (err) => {
    req.url = saved;
    next(err);
  });
});
app.patch("/api/auth/profile", (req, res, next) => {
  const saved = req.url;
  req.url = "/profile";
  authRouter.handle(req, res, (err) => {
    req.url = saved;
    next(err);
  });
});
app.get("/api/auth/my-bookings", (req, res, next) => {
  const saved = req.url;
  const q = saved.includes("?") ? saved.slice(saved.indexOf("?")) : "";
  req.url = `/my-bookings${q}`;
  authRouter.handle(req, res, (err) => {
    req.url = saved;
    next(err);
  });
});
app.post("/api/auth/refresh", (req, res, next) => {
  const saved = req.url;
  req.url = "/refresh";
  authRouter.handle(req, res, (err) => {
    req.url = saved;
    next(err);
  });
});
app.use("/api/auth", authRouter);
console.log("[boot] mounted /api/auth", summarizeAuthRouterPaths(authRouter).join(" | ") || "(no routes on stack)");

try {
  const { renderSuperAdminRecoveryPage } = require("./superAdminRecoveryPage.cjs");
  const { isOutageRecoveryEnabled } = require("./superAdminLoginChallenge.cjs");
  app.get("/super-admin-recovery", (_req, res) => {
    const frontendUrl =
      process.env.FRONTEND_URL ||
      process.env.PUBLIC_WEB_URL ||
      "https://ifcdcbarbersapp.com";
    res
      .status(200)
      .type("html")
      .send(
        renderSuperAdminRecoveryPage({
          frontendUrl,
          outageOn: isOutageRecoveryEnabled(),
        }),
      );
  });
  console.log("[boot] mounted GET /super-admin-recovery");
} catch (e) {
  console.warn("[boot] super-admin-recovery page skipped:", e?.message || e);
}

/** Mobile app bookings — must register before the 404 handler (and any future catch-alls). */
app.get("/api/app-bookings/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const envRaw = String(process.env.PAYPAL_ENV || process.env.PAYPAL_MODE || "").toLowerCase();
  const isLive = envRaw === "live" || envRaw === "production" || envRaw === "prod";
  res.json({
    ok: true,
    paypal: {
      environment: isLive ? "live" : "sandbox",
      apiBase: isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
      clientIdSet: Boolean(String(process.env.PAYPAL_CLIENT_ID || "").trim()),
      secretSet: Boolean(String(process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_SECRET || "").trim()),
      PAYPAL_ENV: process.env.PAYPAL_ENV || null,
      PAYPAL_MODE: process.env.PAYPAL_MODE || null,
    },
  });
});

const {
  handlePublicBarberServicesGet,
  handlePublicBarbersListGet,
} = require("./bookingPublicHandlers.cjs");

/** Public booking catalog — register before app-bookings router (no auth). */
app.get("/api/app-bookings/services", async (req, res) => {
  try {
    return await handlePublicBarberServicesGet(req, res, dbQuery);
  } catch (e) {
    console.error("[services] GET /api/app-bookings/services:", e?.message || e);
    return res.status(500).json({ error: "server_error", message: "Failed to load services" });
  }
});

app.get("/api/app-bookings/barbers", async (req, res) => {
  try {
    return await handlePublicBarbersListGet(req, res, dbQuery);
  } catch (e) {
    console.error("[app-bookings] GET /api/app-bookings/barbers:", e?.message || e);
    return res.status(500).json({ ok: false, error: "barbers_failed", message: e?.message || String(e) });
  }
});

app.use("/api/app-bookings", appBookingCheckoutRoutes);
console.log("[boot] mounted public GET /api/app-bookings/services|barbers|health + USE /api/app-bookings");

/** Public bookable services — no auth; authenticated management uses barber-business router. */
app.get("/api/barber/services", async (req, res, next) => {
  if (req.headers.authorization || req.headers.Authorization) return next();
  try {
    return await handlePublicBarberServicesGet(req, res, dbQuery);
  } catch (e) {
    console.error("[services] GET /api/barber/services:", e?.message || e);
    return res.status(500).json({ error: "server_error", message: "Failed to load services" });
  }
});
console.log("[boot] mounted public GET /api/barber/services (no auth)");

app.get("/api/barber/available-slots", handleBarberAvailableSlotsGet);
console.log("[boot] mounted GET /api/barber/available-slots");

app.post("/api/sms/status", (req, res) => {
  console.log("📬 DELIVERY UPDATE:", req.body);
  res.sendStatus(200);
  void handleTwilioSmsStatusCallback(req.body || {}).catch((e) => {
    console.error("[api/sms/status] handler error:", e);
  });
  void (async () => {
    try {
      const { enrichSmsStatusCallback } = require("./smsRoutes.cjs");
      await enrichSmsStatusCallback(dbQuery, req.body || {});
    } catch (e) {
      console.warn("[api/sms/status] sms_message_log update:", e?.message || e);
    }
  })();
});

try {
  const { createSmsRouter } = require("./smsRoutes.cjs");
  app.use(
    "/api/sms",
    createSmsRouter({
      dbQuery,
      resolveAuthPayload,
      isSuperAdminEmail,
    }),
  );
  console.log("[boot] mounted /api/sms (verify, consent, inbound, admin history)");
} catch (e) {
  console.warn("[boot] /api/sms mount skipped:", e?.message || e);
}

try {
  const { createAuraVoiceIntelligenceRouter } = require("./auraVoiceIntelligenceRoutes.cjs");
  app.use(
    "/api/aura/voice-intelligence",
    createAuraVoiceIntelligenceRouter({
      dbQuery,
      resolveAuthPayload,
      isSuperAdminEmail,
    }),
  );
  console.log("[boot] mounted /api/aura/voice-intelligence (Phase 1 status + admin)");
} catch (e) {
  console.warn("[boot] /api/aura/voice-intelligence mount skipped:", e?.message || e);
}

app.use(
  session({
    secret: String(process.env.SESSION_SECRET || "aura-secret"),
    resave: false,
    saveUninitialized: true,
  }),
);

/**
 * Admin / super_admin JWT or x-admin-key — used on booking admin routes (router is mounted before generic app.use guards).
 */
function requireAdminOrSuper(req, res, next) {
  const adminKey = String(req.get("x-admin-key") || "").trim();
  const expected = String(process.env.ADMIN_SECRET || "").trim();
  if (expected && adminKey && adminKey === expected) return next();

  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
  if (!token) return res.status(401).json({ ok: false, message: "Missing Bearer token" });
  const payload = resolveAuthPayload(token);
  if (!payload) return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  const role = String(payload?.role || "");
  if (role === "super_admin" || role === "admin") return next();
  return res.status(403).json({ ok: false, message: "Access denied" });
}

// Backwards-compat: keep legacy endpoints used by older client code.
app.post("/api/login", async (req, res) => {
  // delegate to /api/auth/login
  req.url = "/login";
  authRouter.handle(req, res, () => {});
});
app.post("/api/register", async (req, res) => {
  req.url = "/register";
  authRouter.handle(req, res, () => {});
});

app.get("/api/aura/status", (_req, res) => {
  res.json(auraStatusPayload());
});

/** Local/ngrok wiring check — no Twilio body required. */
app.get("/api/aura/test", (req, res) => {
  console.log("✅ TEST ROUTE HIT", {
    time: new Date().toISOString(),
    path: req.path,
    ip: req.ip,
    ua: String(req.get("user-agent") || "").slice(0, 120),
  });
  res.send("AURA TEST OK");
});

/**
 * GET /api/test-email?to=… — send one test message (production MAIL_FROM).
 * POST /api/test-email — body `{ "to" }` or query `?to=`.
 */
async function runTestEmailSend(to, res) {
  console.log(
    "[EMAIL] test-email: RESEND_API_KEY:",
    getResend() ? "LOADED" : "MISSING",
    "MAIL_FROM:",
    getMailFrom() || "MISSING"
  );

  const result = await sendEmail({
    to,
    subject: "IFCDC System Test",
    html: "<p>IFCDC transactional email test ✅</p>",
    label: "test-email",
  });
  if (result.error) {
    const msg = result.error.message != null ? String(result.error.message) : JSON.stringify(result.error);
    console.error("[EMAIL ERROR]", msg);
    const isConfig = /RESEND_API_KEY|MAIL_FROM/i.test(msg);
    return res.status(isConfig ? 503 : 200).json({
      success: false,
      error: msg,
      hint: "Verify MAIL_FROM at resend.com/domains and RESEND_API_KEY at resend.com/api-keys",
    });
  }
  return res.json({
    success: true,
    to,
    messageId: result?.data?.id ?? null,
  });
}

/** GET /api/email/health — Resend config status (no secrets). */
app.get("/api/email/health", (_req, res) => {
  const keyOk = Boolean(getResend());
  const mailFrom = getMailFrom();
  const fromEmail = mailFrom ? String(mailFrom).replace(/.*<([^>]+)>/, "$1").trim() : "";
  const domain = fromEmail.includes("@") ? fromEmail.split("@")[1] : "";
  res.json({
    ok: keyOk && Boolean(mailFrom),
    resendApiKey: keyOk ? "configured" : "missing_or_invalid",
    mailFrom: mailFrom || null,
    mailFromDomain: domain || null,
    expectedDomain: "ifcdcbarbersapp.com",
    bookingAdminEmail: String(process.env.BOOKING_ADMIN_EMAIL || "service@ifcdc.org").trim(),
  });
});

async function handleGetTestEmail(req, res) {
  const to = String(req.query.to || req.query.email || "").trim();
  if (!to) {
    return res.status(400).json({
      success: false,
      error: "to_required",
      message: "Use GET /api/test-email?to=you@example.com",
    });
  }
  return runTestEmailSend(to, res);
}

async function handlePostTestEmail(req, res) {
  const to = String(req.body?.to || req.query?.to || "").trim();
  if (!to) {
    return res.status(400).json({
      success: false,
      error: "to_required",
      message: 'Send JSON body { "to": "you@example.com" } or use GET /api/test-email?to=…',
    });
  }
  return runTestEmailSend(to, res);
}

/**
 * PayPal instant payment notification — register this URL in PayPal Developer → Webhooks.
 * Responds 200 immediately, then sends payment success + admin emails (async).
 */
app.post("/api/paypal/webhook", (req, res) => {
  res.status(200).json({ ok: true, received: true });
  (async () => {
    try {
      await handlePaypalWebhookEvent(req.body || {});
    } catch (e) {
      console.error("[paypal] webhook async processing failed (full):", e?.stack || e);
    }
  })();
});

/** POST /api/payments/create-order | capture-order — PayPal server SDK (requires PAYPAL_* secrets). */
app.use("/api/payments", paypalPaymentRoutes);
// Aliases (requested naming)
app.use("/api/paypal", paypalPaymentRoutes);

// CMS + booking styles mounted in startServer() (after DB migrations, before listen).
const apiStylesStack = express.Router();
app.use("/api/styles", apiStylesStack);
app.use("/styles", apiStylesStack);

const requireBookingsAdmin = createBookingsAdminGuard({ resolveAuthPayload, dbQuery });

// Push notifications — Expo only (no SMS, no Twilio, no AURA).
const pushNotifier = require("./pushNotifier.cjs");
app.use(
  "/api/notifications",
  createNotificationRouter({
    sendPushToUsers: pushNotifier.sendPushToUsers,
    isExpoPushToken: pushNotifier.isExpoPushToken,
  }),
);
console.log(
  "[boot] mounted /api/notifications (register-token, preferences, test)",
);

// Legal & compliance acceptance log (App Store / Play Store readiness).
app.use("/api/legal", createLegalRouter());
console.log("[boot] mounted /api/legal (accept, status)");

// Production bookings (Postgres) — replaces in-memory bookingRoutesMinimal.cjs for live payments.
const bookingsRouter = createBookingsRouter({
  sendBookingEmail: require("./bookingEmail.cjs").sendBookingEmail,
  sendBookingPush: pushNotifier.sendBookingPush,
  requireAdmin: requireBookingsAdmin,
});
app.use(bookingsRouter);
app.use(
  "/api/admin/manual-bookings",
  createManualBypassBookingRouter({
    sendBookingEmail: require("./bookingEmail.cjs").sendBookingEmail,
  }),
);
console.log("[boot] mounted /api/admin/manual-bookings (Super Admin bypass mode)");

// AURA Phase 2 ops (feature-flagged; returns 404 when AURA_PHASE2_ENABLED is off)
{
  const { createAuraPhase2Router } = require("./auraPhase2Routes.cjs");
  app.use(
    "/api/aura/phase2",
    createAuraPhase2Router({
      dbQuery,
      requireAdmin: requireBookingsAdmin,
    }),
  );
  console.log("[boot] mounted /api/aura/phase2 (disabled unless AURA_PHASE2_ENABLED=1)");
}

// AURA Phase 3 knowledge (feature-flagged; returns 404 when AURA_PHASE3_ENABLED is off)
{
  const { createAuraPhase3Router } = require("./auraKnowledgeRoutes.cjs");
  app.use(
    "/api/aura/phase3",
    createAuraPhase3Router({
      dbQuery,
      requireAdmin: requireBookingsAdmin,
      requireAuth,
    }),
  );
  console.log("[boot] mounted /api/aura/phase3 (disabled unless AURA_PHASE3_ENABLED=1)");
}

const adminUsersRouter = createAdminUsersRouter({ sendEmail });
app.use(adminUsersRouter);
app.use(createAdminBarbersRouter());
app.use(createSocialPortfolioRouter());
app.use(createLoyaltyRouter());
app.use(
  "/api/hubspot",
  createHubSpotRouter({
    requireAuth: (req, res, next) => {
      // Allow ADMIN_SECRET for ops verification (same pattern as booking/barber admin).
      const adminKey = String(req.get("x-admin-key") || "").trim();
      const expected = String(process.env.ADMIN_SECRET || "").trim();
      if (expected && adminKey && adminKey === expected) {
        req.user = req.user || { role: "admin", isSuperAdmin: true };
        return next();
      }
      return requireAuth(req, res, next);
    },
    requireAdmin: (req, res, next) => {
      const adminKey = String(req.get("x-admin-key") || "").trim();
      const expected = String(process.env.ADMIN_SECRET || "").trim();
      if (expected && adminKey && adminKey === expected) return next();
      const role = String(req.user?.role || "").toLowerCase();
      if (role === "admin" || role === "super_admin" || req.user?.isSuperAdmin === true) {
        return next();
      }
      return res.status(403).json({ ok: false, message: "Access denied." });
    },
  }),
);
console.log("[boot] mounted /api/hubspot (health, status, verify)");
app.use(
  "/api/admin/hubspot",
  createAdminHubSpotRouter({
    requireAuth: (req, res, next) => {
      const adminKey = String(req.get("x-admin-key") || "").trim();
      const expected = String(process.env.ADMIN_SECRET || "").trim();
      if (expected && adminKey && adminKey === expected) {
        req.user = req.user || { role: "admin", isSuperAdmin: true };
        return next();
      }
      return requireAuth(req, res, next);
    },
    requireAdmin: (req, res, next) => {
      const adminKey = String(req.get("x-admin-key") || "").trim();
      const expected = String(process.env.ADMIN_SECRET || "").trim();
      if (expected && adminKey && adminKey === expected) return next();
      const role = String(req.user?.role || "").toLowerCase();
      if (role === "admin" || role === "super_admin" || req.user?.isSuperAdmin === true) {
        return next();
      }
      return res.status(403).json({ ok: false, message: "Access denied." });
    },
  }),
);
console.log("[boot] mounted /api/admin/hubspot (kpis)");
app.use(createAdminShopsRouter());
console.log(
  "[admin] routes mounted: invite, audit, password-reset, barbers, shops, notifications",
);

const barberBusinessUploadDir = path.join(__dirname, "backend", "uploads");
app.use(createBarberBusinessRouter({ uploadDir: barberBusinessUploadDir }));
mountBarberOnboardingRoutes(app, { uploadDir: barberBusinessUploadDir });
mountOnboardingBusinessRoutes(app);

const insertAuraVoiceRow = (body) =>
  insertAuraVoiceBookingRow(body, require("./bookingEmail.cjs").sendAuraVoiceBookingEmail);
attachAuraVoiceRoutes(app, { insertVoiceRow: insertAuraVoiceRow, dbQuery });
attachAuraSmsWebhook(app, { insertVoiceRow: insertAuraVoiceRow });
console.log(
  "[aura] Webhook routes attached: GET|POST /api/aura/voice (Twilio POST + GET probe), POST /api/aura/sms, GET /api/aura/test" +
    (String(process.env.AURA_VOICE_WIZARD || "").trim() === "1"
      ? " [AURA_VOICE_WIZARD=1: legacy voice booking wizard — unset for OpenAI simple voice]"
      : " [voice: instant TwiML → POST /api/aura/process (OpenAI) → Gather → /api/aura/voice — set AURA_VOICE_WIZARD=1 only for the old booking wizard]"),
);
console.log("[aura] GET /api/aura/status — wiring check (OpenAI / Twilio flags, no secrets)");

// NOTE: in-memory booking routes removed for production persistence.

const manageBarbersMiddleware = (req, res, next) => {
  const adminKey = String(req.get("x-admin-key") || "").trim();
  const expected = String(process.env.ADMIN_SECRET || "").trim();
  if (expected && adminKey && adminKey === expected) return next();

  const hdr = String(req.get("authorization") || "");
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice("bearer ".length).trim() : "";
  if (!token) return res.status(401).json({ ok: false, message: "Missing Bearer token" });
  const payload = resolveAuthPayload(token);
  if (!payload) return res.status(401).json({ ok: false, message: "Invalid or expired token" });
  const role = String(payload?.role || "");
  if (role === "super_admin" || role === "admin") return next();
  return res.status(403).json({ ok: false, message: "Access denied" });
};

mountProductionBarbersRoutes(app, { manageMiddleware: manageBarbersMiddleware });

// Legacy /uploads paths still served for older rows (new uploads use Supabase public URLs)
const uploadsDir = path.join(__dirname, "backend", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ifcdc-barbers-api" });
});

/** Production deploy verification — active git commit vs expected 8a3a601d. */
app.get("/api/deploy-info", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(await getDeployInfoPayload());
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "deploy_info_failed",
      message: e?.message || String(e),
    });
  }
});

/** Live Supabase Storage probe for TestFlight / ops (no secrets returned). */
app.get("/api/storage-health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { getSupabaseInitStatus, probeSupabaseStorage } = await import("./src/db/supabaseServiceClient.js");
    const init = getSupabaseInitStatus();
    const probe = await probeSupabaseStorage();
    const ok = Boolean(init.clientReady && probe.ok);
    res.status(ok ? 200 : 503).json({
      ok,
      ...init,
      probe,
      uploadsRoute: "/api/upload",
      message: ok
        ? "Photo storage is configured and reachable."
        : init.lastError || probe.reason || "Photo storage is not ready.",
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: "storage_health_failed",
      message: e?.message || String(e),
    });
  }
});

app.get("/api/health", (req, res) => {
  const payload = { status: "OK" };
  if (String(req.query.aura || "").trim() === "1") {
    payload.aura = auraStatusPayload();
  }
  res.json(payload);
});

app.get("/voice", (req, res) => {
  res.set("Content-Type", "text/xml; charset=utf-8");
  const greet = ssmlThanksCallingOpener("en");
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Ivy" language="en-US">${greet}</Say></Response>`);
});

/**
 * POST /api/call — Phone page “Call Now”.
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.
 * TwiML: use PUBLIC_API_URL or TWILIO_VOICE_URL for GET /voice; otherwise inline TwiML (TWILIO_CALL_TWIML or default).
 */
app.post("/api/call", async (req, res) => {
  try {
    const { number } = req.body || {};
    const raw = String(number ?? "").trim();
    if (!raw) {
      return res.status(400).json({ ok: false, error: "number required" });
    }

    const client = globalThis.__ifcdcTwilioClient;
    if (!client) {
      return res.json({
        ok: true,
        mode: "stub",
        message:
          "Number logged. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env to place real calls.",
      });
    }

    const from = String(process.env.TWILIO_PHONE_NUMBER || "").trim();
    if (!from) {
      return res.status(503).json({
        ok: false,
        error: "twilio_from_missing",
        message:
          "Set TWILIO_PHONE_NUMBER to your Twilio phone number (E.164, e.g. +15551234567) in .env.",
      });
    }

    const to = normalizeOutboundTo(raw);
    if (!to) {
      return res.status(400).json({
        ok: false,
        error: "invalid_number",
        message: "Enter a valid phone number (10 digits or +country code).",
      });
    }

    const twimlUrl = resolveVoiceTwimlUrl();
    const callParams = { to, from };
    if (twimlUrl) {
      callParams.url = twimlUrl;
    } else {
      callParams.twiml = defaultOutboundCallTwiml();
    }

    console.log("[api/call] creating call", { to, from, twimlMode: twimlUrl ? "url" : "inline" });

    const call = await client.calls.create(callParams);

    return res.json({
      ok: true,
      mode: "call",
      twimlMode: twimlUrl ? "url" : "inline",
      sid: call.sid,
      status: call.status,
      message: twimlUrl
        ? "Call initiated. Twilio will fetch TwiML from your voice URL."
        : "Call initiated with inline TwiML (set PUBLIC_API_URL or TWILIO_VOICE_URL to use GET /voice instead).",
    });
  } catch (err) {
    console.error("[api/call]", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.code || "twilio_error",
      message: err?.message || String(err),
    });
  }
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "ifcdc-barbers-api", port: 5050 });
});

/** Test email — GET query ?to= ; POST body { to } */
app.get("/api/test-email", handleGetTestEmail);
app.get("/test-email", handleGetTestEmail);
app.post("/api/test-email", handlePostTestEmail);
app.post("/test-email", handlePostTestEmail);

/** Public config for the client (shop business phone, AURA line, etc.). */
app.get("/api/config", async (req, res) => {
  try {
    const businessId = req.query.businessId ?? req.query.business_id ?? null;
    const { phone, source } = await resolvePublicBusinessPhone(businessId);
    // Prefer dedicated AURA / shop public line; platform IFCDC number is the shared fallback.
    let shopTelephony = null;
    if (businessId != null && String(businessId).trim() !== "") {
      try {
        const { getShopTelephonySettings } = require("./auraShopTelephonyAdmin.cjs");
        shopTelephony = await getShopTelephonySettings(dbQuery, businessId);
      } catch {
        shopTelephony = null;
      }
    }
    const platformAura = String(AURA_NUMBER || BUSINESS_PHONE || "").trim() || "+19895141064";
    const shopPublic =
      shopTelephony?.publicPhoneNumber ||
      shopTelephony?.twilioPhoneNumber ||
      phone ||
      null;
    const displayPhone = shopPublic || platformAura;
    const callLabel = shopTelephony?.shopName
      ? `Call ${shopTelephony.shopName}`
      : "Call IFCDC Barbers App";
    res.json({
      phone: displayPhone || null,
      phoneDisplay: shopTelephony?.publicPhoneDisplay || null,
      auraPhone: platformAura || null,
      phoneSource: shopTelephony?.publicPhoneNumber ? "shop_telephony" : source,
      phoneLabel: shopTelephony?.shopName || (displayPhone ? "IFCDC Barbers App" : null),
      callButtonLabel: callLabel,
      callTelHref: displayPhone
        ? `tel:${String(displayPhone).startsWith("+") ? displayPhone : `+${String(displayPhone).replace(/\D/g, "")}`}`
        : `tel:+19895141064`,
      shopId: shopTelephony?.shopId || (businessId != null ? Number(businessId) : null),
      shopName: shopTelephony?.shopName || null,
      platformSharedNumber: "+19895141064",
      telephony: shopTelephony
        ? {
            voiceEnabled: shopTelephony.voiceEnabled,
            smsEnabled: shopTelephony.smsEnabled,
            auraEnabled: shopTelephony.auraEnabled,
            timezone: shopTelephony.timezone,
          }
        : null,
    });
  } catch (e) {
    console.error("[api/config]", e);
    res.status(500).json({ error: "config_failed", message: e?.message || String(e) });
  }
});

/**
 * POST /api/aura | /api/aura/chat | /api/ai/chat — AURA text assistant.
 * Response: { success: true, message, reply, action }
 */
async function handleAuraChatRequest(req, res) {
  const clientLangHint = detectClientLanguage(req);
  console.log("[aura/chat] request received", {
    path: req.path,
    ip: req.ip,
    hasMessage: Boolean(String(req.body?.message || "").trim()),
    historyLen: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
    clientLang: clientLangHint || null,
  });
  try {
    const { message, messages } = req.body || {};
    let thread = [];
    if (Array.isArray(messages) && messages.length > 0) {
      thread = messages
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            String(m.content ?? "").trim()
        )
        .map((m) => ({ role: m.role, content: String(m.content).trim() }));
    }
    if (thread.length === 0) {
      const m = String(message || "").trim();
      if (!m) {
        const Lempty = clientLangHint || "en";
        const emptyReply =
          Lempty === "es"
            ? "Dígame qué necesita: reservar, horarios, servicios o cómo llegar."
            : "Tell me what you need — booking, hours, services, or directions.";
        return res.status(200).json(
          auraChatJson(emptyReply, "NONE", { language: Lempty, replyLanguage: Lempty }),
        );
      }
      thread = [{ role: "user", content: m }];
    }

    const lastUser = auraLastUserText({ message, messages: thread });

    const bodyBid = Number(req.body?.barberId ?? req.body?.barber_id);
    let barberLang = "en";
    if (Number.isFinite(bodyBid) && bodyBid > 0) {
      try {
        const st = await loadBarberSettingsRow(bodyBid);
        barberLang = st?.language || "en";
        const allowFreeAuraChat = String(process.env.AURA_ALLOW_FREE_TIER_CHAT || "").trim() === "1";
        if (!barberAuraEffective(st) && !allowFreeAuraChat) {
          const L0 = resolveAuraLanguage(req, barberLang);
          const reply =
            L0 === "es"
              ? "AURA no está disponible en el plan Free. Actualiza a Pro o Elite para activar el asistente."
              : "AURA is not available on the Free plan. Upgrade to Pro or Elite to enable the assistant.";
          return res.status(200).json({
            success: true,
            message: reply,
            reply,
            action: "NONE",
            aura_available: false,
            language: L0,
            reply_language: L0,
          });
        }
      } catch (e) {
        console.warn("[aura/chat] barber settings:", e?.message || e);
      }
    }
    // Customer app preference wins; barber language is the fallback. English is always the
    // final safety net so AURA never goes silent if the locale data is missing.
    const L = resolveAuraLanguage(req, barberLang);
    console.log("[aura/chat] language resolved", {
      L,
      clientLang: clientLangHint || null,
      barberLang: normalizeBarberLang(barberLang),
      userMsgPreview: String(lastUser || "").slice(0, 120),
    });

    // Per-response audit metadata for admin oversight. The mobile client treats
    // these as opaque hints; admin tooling/logs use them to keep an English mirror.
    const meta = {
      language: L,
      replyLanguage: L,
      originalMessage: String(lastUser || "").slice(0, 8000),
    };

    const kw = auraStructuredIntentFromKeywords(lastUser, L);
    if (kw.matched) {
      console.log("[aura/chat] keyword intent:", kw.intent, "lang:", L);
      if (kw.intent === "NAVIGATE_BOOK") {
        const replyEs = auraChatNavigateBook(L);
        const replyEn = L === "en" ? replyEs : auraChatNavigateBook("en");
        return res.json(
          auraChatJson(replyEs, "NAVIGATE_BOOK", { ...meta, adminMessageEn: replyEn }),
        );
      }
      if (kw.intent === "NAVIGATE_STYLES") {
        let extra = "";
        try {
          const titles = await auraFetchStyleTitles(30);
          if (titles.length) {
            extra =
              L === "es"
                ? ` Estilos que ofrecemos: ${titles.join(", ")}.`
                : ` Styles we offer include: ${titles.join(", ")}.`;
          }
        } catch (e) {
          console.warn("[aura/chat] style list:", e?.message || e);
        }
        const opener = L === "es" ? "Listo — abriendo estilos ahora." : "I got you — opening styles now.";
        const styled = `${opener}${extra}${auraChatNavigateStylesSuffix(L)}`;
        const styledEn =
          L === "en"
            ? styled
            : `I got you — opening styles now.${auraChatNavigateStylesSuffix("en")}`;
        return res.json(
          auraChatJson(styled, "NAVIGATE_STYLES", { ...meta, adminMessageEn: styledEn }),
        );
      }
      if (kw.intent === "PRICING" || kw.intent === "HOURS" || kw.intent === "DIRECTIONS" || kw.intent === "SERVICES") {
        const action = kw.intent === "PRICING" || kw.intent === "SERVICES" ? "NAVIGATE_STYLES" : "NONE";
        let reply = kw.reply;
        let replyEn = kw.reply;
        let knowledgeMeta = null;
        try {
          const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
          const p3 = auraPhase3Flags();
          if (p3.knowledge) {
            const { answerKnowledgeQuestion } = require("./auraKnowledgeService.cjs");
            const kn = await answerKnowledgeQuestion(dbQuery, lastUser, {
              userId: req.user?.id || null,
              shopId: req.body?.shopId || req.body?.businessId || req.user?.business_id || 1,
              businessId: req.body?.businessId || req.body?.shopId || req.user?.business_id || 1,
            });
            if (kn?.ok && kn.answer) {
              reply = kn.answer;
              replyEn = kn.answer;
              knowledgeMeta = {
                confidence: kn.confidence,
                source: kn.source,
                version: kn.version,
                escalate: false,
              };
            } else if (kn?.escalate) {
              reply = kn.message || reply;
              replyEn = reply;
              knowledgeMeta = { escalate: true, reason: kn.reason || null };
            }
          }
        } catch (e) {
          console.warn("[aura/chat] phase3 knowledge:", e?.message || e);
        }
        if (!knowledgeMeta && L !== "en") {
          try {
            const kwEn = auraStructuredIntentFromKeywords(lastUser, "en");
            if (kwEn.matched && kwEn.reply) replyEn = kwEn.reply;
          } catch (e) {
            console.warn("[aura/chat] english mirror:", e?.message || e);
          }
        }
        return res.json(
          auraChatJson(reply, action, {
            ...meta,
            adminMessageEn: replyEn,
            knowledge: knowledgeMeta,
          }),
        );
      }
    }

    // Prevent dead ends: for unclear short messages, respond instantly (no OpenAI).
    const cleaned = String(lastUser || "").trim();
    const wordCount = cleaned ? cleaned.split(/\s+/).filter(Boolean).length : 0;
    if (
      !cleaned ||
      wordCount <= 2 ||
      /\b(help|what can you do|options|ayuda|qu[eé] puedes hacer|opci[oó]nes)\b/i.test(cleaned)
    ) {
      const localized = auraUnclearFallbackReply(L);
      const englishMirror = L === "en" ? localized : auraUnclearFallbackReply("en");
      return res.json(auraChatJson(localized, "NONE", { ...meta, adminMessageEn: englishMirror }));
    }

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      console.warn("[aura/chat] OPENAI_API_KEY missing — using keyword fallback");
      const localized = auraKeywordFallbackReply(L);
      const englishMirror = L === "en" ? localized : auraKeywordFallbackReply("en");
      return res
        .status(200)
        .json(auraChatJson(localized, "NONE", { ...meta, adminMessageEn: englishMirror }));
    }

    const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
    let system = AURA_ASSISTANT_PROMPT + openAiLanguageInstruction(L);
    if (/\b(price|cost|pricing|how\s+much)\b/i.test(cleaned)) {
      system +=
        L === "es"
          ? " El usuario puede preguntar por precio. Explique que cada estilo tiene su precio en la página Estilos y que abra Estilos para comparar. No invente montos en dólares."
          : " The user may be asking about price or cost. Explain that each style has its own price on the Styles page, and they should open Styles to compare. Do not invent dollar amounts.";
    }

    const out = await auraOpenAiChat({ apiKey, model, systemPrompt: system, thread });
    const base = String(out.reply || "").trim() || auraUnclearFallbackReply(L);
    // Gentle next-step suggestion in the customer's language.
    const navigateHint =
      L === "es"
        ? "\n\nSi quiere, diga: reservar, estilos o precios — y lo llevo."
        : "\n\nIf you want, tell me: book, styles, or pricing — and I’ll take you there.";
    const reply = base + (/\b(book|booking|appointment)\b/i.test(base) ? "" : navigateHint);
    return res.json(auraChatJson(reply, "NONE", meta));
  } catch (e) {
    console.error("[aura/chat] route failure:", e?.stack || e);
    return res.status(200).json(auraChatJson(AURA_FAILSAFE_REPLY, "NONE", { language: "en", replyLanguage: "en" }));
  }
}

const AURA_CHAT_PATHS = ["/api/aura", "/api/aura/chat", "/api/ai/chat"];
for (const auraPath of AURA_CHAT_PATHS) {
  app.post(auraPath, handleAuraChatRequest);
}
console.log("[boot] mounted POST", AURA_CHAT_PATHS.join(" | "));

async function startServer() {
  // DB migrations needed for auth / RBAC.
  try {
    await ensureUsersRoleColumn();
    await ensureGoogleAuthSupport();
    await ensureAppleAuthSupport();
    await ensurePendingInvitesTable();
    await ensurePasswordRecoveryColumns();
  } catch (e) {
    console.error("[migrate] app_users/role failed:", e?.message || e);
  }
  try {
    await ensureBarberBusinessTables();
    await ensureAdminBarberManagementSchema();
    await ensureProviderTypeSchema();
    await ensurePreferredLanguageSchema().catch((e) =>
      console.warn("[boot] preferred_language:", e?.message || e),
    );
    await ensureAdminShopManagementSchema();
    try {
      const aligned = await ensureAppUsersBarberIdTypeAligned();
      if (aligned?.converted) console.log("[migrate] app_users.barber_id aligned to uuid");
    } catch (alignErr) {
      console.warn("[migrate] app_users.barber_id align:", alignErr?.message || alignErr);
    }
    try {
      const backfill = await backfillOrphanBarberRegistrations({ notify: true });
      if (backfill.fixed > 0) {
        console.log("[migrate] backfilled orphan barber registrations:", backfill);
      }
    } catch (bfErr) {
      console.warn("[migrate] orphan barber backfill:", bfErr?.message || bfErr);
    }
    console.log("[migrate] barber business tables: ok");
  } catch (e) {
    console.error("[migrate] barber business failed:", e?.message || e);
  }
  try {
    await ensureBookingsTable();
    await ensureManualBypassBookingColumns(dbQuery).catch((e) =>
      console.warn("[boot] manual bypass columns:", e?.message || e),
    );
    await ensureSecurityAuditTable();
    await ensureSecurityTenantColumns();
    await ensureBookingStatusHistoryTable();
    await ensurePushNotificationsSchema();
    await ensureLegalAcceptanceSchema();
    await ensureAuraMemoryTables();
  } catch (e) {
    console.error("[migrate] bookings failed:", e?.message || e);
  }
  try {
    await ensureSocialPortfolioSchema();
    console.log("[migrate] social portfolio schema: ok");
  } catch (e) {
    console.error("[migrate] social portfolio failed:", e?.message || e);
  }
  try {
    await ensureLoyaltySchema();
    await seedDefaultRewardsIfEmpty();
    await expireStaleRewardReservations();
    console.log("[migrate] loyalty schema: ok");
  } catch (e) {
    console.error("[migrate] loyalty failed:", e?.message || e);
  }
    try {
    await ensureHubSpotSchema();
    const { clearHubSpotClientState, isHubSpotConfigured, isHubSpotSyncEnabled } = await import(
      "./hubspotService.js"
    );
    clearHubSpotClientState();
    console.log("[migrate] hubspot schema: ok", {
      configured: isHubSpotConfigured(),
      syncEnabled: isHubSpotSyncEnabled(),
      credentialSource: "HUBSPOT_SERVICE_KEY",
    });

    // Phase 2C: Starter properties + marketing emails (Workflows API optional / Pro+).
    void import("./hubspotPhase2cSetupService.js")
      .then(async (m) => {
        const setup = await m.ensurePhase2cHubSpotSetup({
          enableWorkflows: false,
        });
        console.log("[hubspot] phase2c_setup", {
          ok: setup.ok,
          subscriptionMode: setup.subscriptionMode,
          workflowProvisionMode: setup.workflowProvisionMode,
          propertyCount: setup.properties?.length || 0,
          emailOk: (setup.emails || []).filter((e) => e.id).length,
          workflowProvisioned: (setup.workflows || []).filter((w) =>
            ["exists", "created", "starter_manual", "manual_ui_or_simple_automations"].includes(
              String(w.status || ""),
            ),
          ).length,
          workflowApiOk: (setup.workflows || []).filter((w) =>
            ["exists", "created"].includes(String(w.status || "")),
          ).length,
          notes: setup.notes || [],
        });
        const backfill = await m.runSafeHubSpotMappingBackfill({ limit: 25 });
        console.log("[hubspot] safe_backfill", {
          skipped: backfill.skipped,
          reason: backfill.reason || null,
          queuedCompanies: backfill.queuedCompanies,
          queuedDeals: backfill.queuedDeals,
        });
      })
      .catch((error) => console.warn("[hubspot] phase2c_setup failed:", error?.message || error));
  } catch (e) {
    console.error("[migrate] hubspot failed:", e?.message || e);
  }
  setInterval(() => {
    void expireStaleRewardReservations().catch((error) =>
      console.warn("[loyalty] reservation expiry:", error?.message || error),
    );
  }, 5 * 60 * 1000);

  // Release abandoned PayPal checkout slot holds
  const runPendingBookingCleanup = async () => {
    try {
      const { expireStalePendingPaymentBookings } = require("./bookingCleanup.cjs");
      const { dbQuery } = await import("./db.js");
      await expireStalePendingPaymentBookings(dbQuery);
    } catch (error) {
      console.warn("[booking-cleanup] interval failed:", error?.message || error);
    }
  };
  void runPendingBookingCleanup();
  setInterval(() => {
    void runPendingBookingCleanup();
  }, 5 * 60 * 1000);

  void import("./socialPortfolioService.js")
    .then((m) => m.sendDueFollowupReminders())
    .then((r) => {
      if (r?.sent) console.log(`[followup] sent ${r.sent} reminder(s) on boot`);
    })
    .catch(() => {});
  setInterval(() => {
    void import("./socialPortfolioService.js")
      .then((m) => m.sendDueFollowupReminders())
      .catch(() => {});
  }, 6 * 60 * 60 * 1000);

  // Pending email deliveries — preserve failed confirmation emails for retry (provider outages).
  // Does not alter RESEND_* / MAIL_FROM or payment settlement.
  try {
    const { ensurePendingEmailDeliveryTable } = require("./pendingEmailDelivery.cjs");
    await ensurePendingEmailDeliveryTable(dbQuery);
    console.log("[boot] pending_email_deliveries schema ensured");
  } catch (e) {
    console.warn("[boot] pending_email_deliveries schema skipped:", e?.message || e);
  }

  try {
    const { ensureSuperAdminLoginChallengeTable } = require("./superAdminLoginChallenge.cjs");
    await ensureSuperAdminLoginChallengeTable(dbQuery);
    console.log("[boot] super_admin_login_challenges schema ensured");
  } catch (e) {
    console.warn("[boot] super_admin_login_challenges schema skipped:", e?.message || e);
  }

  try {
    const { ensureSmsSchema } = require("./smsMigrations.cjs");
    await ensureSmsSchema(dbQuery);
    const { smsFlags } = require("./smsFlags.cjs");
    const { twilioConfigStatus } = require("./smsTwilioClient.cjs");
    console.log("[boot] SMS schema ensured", { flags: smsFlags(), twilio: twilioConfigStatus() });
  } catch (e) {
    console.warn("[boot] SMS schema skipped:", e?.message || e);
  }

  try {
    const { isAuraVoiceIntelligencePhase1 } = require("./auraVoiceIntelligenceFlags.cjs");
    if (isAuraVoiceIntelligencePhase1()) {
      const { ensureAuraVoiceIntelligenceSchema } = require("./auraVoiceIntelligenceMigrations.cjs");
      await ensureAuraVoiceIntelligenceSchema(dbQuery);
      const { ensureAuraFounderSchema } = require("./auraFounderMigrations.cjs");
      await ensureAuraFounderSchema(dbQuery);
      const { ensureAuraShopTelephonySchema } = require("./auraShopTelephonyMigrations.cjs");
      await ensureAuraShopTelephonySchema(dbQuery);
      const { ensureAuraShopTenantIsolation } = require("./auraShopTenantIsolationMigrations.cjs");
      await ensureAuraShopTenantIsolation(dbQuery);
      console.log("[boot] AURA Voice Intelligence Phase 1 + Founder + Shop Telephony + Tenant Isolation schema ensured");
    } else {
      console.log("[boot] AURA Voice Intelligence Phase 1 off (AURA_VOICE_INTELLIGENCE_PHASE_1)");
    }
  } catch (e) {
    console.warn("[boot] AURA Voice Intelligence schema skipped:", e?.message || e);
  }

  // AURA Phase 2 — additive schema + reminder scanners (only when master flag is on)
  try {
    const { isAuraPhase2Enabled, auraPhase2Flags } = require("./auraPhase2Flags.cjs");
    if (isAuraPhase2Enabled()) {
      const { ensureAuraActionLogTable, ensureAuraReminderColumns } = require("./auraActionLog.cjs");
      await ensureAuraActionLogTable(dbQuery);
      await ensureAuraReminderColumns(dbQuery);
      console.log("[boot] AURA Phase 2 schema ensured (action logs + reminder columns)");
      const flags = auraPhase2Flags();
      if (flags.reminders24h || flags.reminders2h || flags.reminders30m) {
        const runAuraReminders = async () => {
          try {
            const { scanAllEnabledBookingReminders } = await import("./bookingReminders.js");
            const out = await scanAllEnabledBookingReminders();
            console.log("[aura-reminders]", out);
          } catch (e) {
            console.warn("[aura-reminders] scan failed:", e?.message || e);
          }
        };
        void runAuraReminders();
        setInterval(() => {
          void runAuraReminders();
        }, 5 * 60 * 1000);
        console.log("[boot] AURA Phase 2 reminder interval armed (5m)");
      }

      // Daily Super Admin report — armed only when send flag + hour/minute configured.
      // Never catch-up-sends on boot/deploy.
      try {
        const { armAuraDailyReportScheduler } = require("./auraDailyReportScheduler.cjs");
        armAuraDailyReportScheduler(dbQuery);
      } catch (e) {
        console.warn("[boot] AURA daily report scheduler skipped:", e?.message || e);
      }
    } else {
      console.log("[boot] AURA Phase 2 master flag off — reminder scanners not started");
    }
  } catch (e) {
    console.warn("[boot] AURA Phase 2 setup skipped:", e?.message || e);
  }

  // AURA Phase 3 knowledge schema (only when master flag is on — still no public answers until articles approved)
  try {
    const { isAuraPhase3Enabled, auraPhase3Flags } = require("./auraPhase3Flags.cjs");
    if (isAuraPhase3Enabled()) {
      const { ensureAuraKnowledgeTables } = require("./auraKnowledgeMigrations.cjs");
      await ensureAuraKnowledgeTables(dbQuery);
      console.log("[boot] AURA Phase 3 knowledge schema ensured");
      const p3 = auraPhase3Flags();
      if (p3.customerPreferences) {
        const { ensureAuraPreferenceTables } = require("./auraPreferenceMigrations.cjs");
        await ensureAuraPreferenceTables(dbQuery);
        console.log("[boot] AURA Phase 3B1 preference schema ensured");
      } else {
        console.log("[boot] AURA Phase 3B1 preferences flag off — preference schema not applied");
      }
      if (p3.waitlist) {
        const { ensureAuraWaitlistTables } = require("./auraWaitlistMigrations.cjs");
        await ensureAuraWaitlistTables(dbQuery);
        console.log("[boot] AURA Phase 3B2 waitlist schema ensured");
      } else {
        console.log("[boot] AURA Phase 3B2 waitlist flag off — waitlist schema not applied");
      }
    } else {
      console.log("[boot] AURA Phase 3 master flag off — knowledge schema not applied");
    }
  } catch (e) {
    console.warn("[boot] AURA Phase 3 setup skipped:", e?.message || e);
  }

  try {
    await ensureStylesTables();
    const seeded = await seedSampleStylesIfEmpty();
    console.log("[seed] styles:", seeded?.seeded ? "seeded" : "ok");
  } catch (e) {
    console.error("[migrate] styles failed:", e?.message || e);
  }
  try {
    const r = await ensureInitialSuperAdmin();
    console.log("[seed] platform_owner:", r?.seeded ? "created/updated" : r?.reason || "ok");
  } catch (e) {
    console.error("[seed] platform_owner failed:", e?.message || e);
  }

  await verifyResendApiKey();
  if (typeof paypalPaymentRoutes.probePayPalOAuthAndLog === "function") {
    await paypalPaymentRoutes.probePayPalOAuthAndLog();
  }

  try {
    const { cmsStylesRouter } = await mountProductionCms(app);
    apiStylesStack.use(cmsStylesRouter);
    apiStylesStack.use(createStylesRouter());
    console.log("[boot] mounted production CMS + styles routes");
  } catch (e) {
    console.error("[boot] production CMS mount failed:", e?.message || e);
    apiStylesStack.use(createStylesRouter());
  }

  try {
    const { logSupabaseKeyStatus } = await import("./src/config/supabaseEnv.js");
    logSupabaseKeyStatus();
    const { getSupabaseInitStatus, probeSupabaseStorage } = await import("./src/db/supabaseServiceClient.js");
    const init = getSupabaseInitStatus();
    const probe = await probeSupabaseStorage();
    const ready = Boolean(init.clientReady && probe.ok);
    console.log(
      ready ? "[boot] ✓ Supabase photo storage READY" : "[boot] ✗ Supabase photo storage NOT READY",
      { bucket: init.bucket, urlHost: init.urlHost, probeOk: probe.ok, reason: probe.reason || init.lastError || null },
    );
    if (process.env.NODE_ENV === "production" && !ready) {
      console.error(
        "[boot] CRITICAL: Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) on Render and ensure bucket barber-styles exists.",
      );
    }
  } catch (e) {
    console.error("[boot] Supabase storage check failed:", e?.message || e);
  }

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      path: req.path,
      method: req.method,
    });
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    try {
      const stack = app?._router?.stack;
      if (Array.isArray(stack)) {
        const summary = stack
          .map((layer) => {
            if (layer?.route?.path != null) {
              const m = layer.route.methods || {};
              const verbs = Object.keys(m)
                .filter((k) => m[k])
                .join(",")
                .toUpperCase();
              return `${verbs} ${layer.route.path}`;
            }
            if (layer?.name === "router") return "USE<Router>";
            return layer?.name ? `mw:${layer.name}` : "mw";
          })
          .filter(Boolean);
        console.log("[boot] Express stack (trimmed):", summary.slice(0, 120).join(" | "));
      }
    } catch (e) {
      console.warn("[boot] route stack log skipped:", e instanceof Error ? e.message : String(e));
    }
    console.log("🚀 Backend running on port:", PORT);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\nPort ${PORT} is already in use. Stop the other process first, e.g.:\n` +
          `  lsof -ti :${PORT} | xargs kill -9\n` +
          "Or: pkill -f \"node server.js\"\n"
      );
      process.exit(1);
    }
    throw err;
  });
}

startServer().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
