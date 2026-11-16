/* ==========================================
   IFCDC BARBERS PLATFORM SERVER
========================================== */

import "../loadBackendEnv.mjs";

const bootImport = async (label, importer) => {
  console.log(`[boot] importing ${label}...`)
  const mod = await importer()
  console.log(`[boot] imported ${label}`)
  return mod
}

const nodePath = await import("node:path")
const nodeUrl = await import("node:url")
const __rootDir = nodePath.join(nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)), "..")
console.log("RESEND KEY STATUS:", process.env.RESEND_API_KEY ? "LOADED" : "MISSING")

/** Render sets RENDER_EXTERNAL_URL (https://your-service.onrender.com). Use it for Twilio TwiML redirects if PUBLIC_BASE_URL is unset. */
if (!process.env.PUBLIC_BASE_URL?.trim() && process.env.RENDER_EXTERNAL_URL?.trim()) {
  process.env.PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL.trim()
}

const { assertProductionEnvironmentOrExit } = await bootImport(
  "config/validateEnv",
  () => import("./config/validateEnv.js")
)

const {
  logSupabaseKeyStatus,
  resolveSupabaseSecretKey,
  resolveViteSupabasePublishableKey,
} = await bootImport("config/supabaseEnv", () => import("./config/supabaseEnv.js"))

/** Loads src/db/supabaseServiceClient.js (currently exports null — no @supabase/supabase-js at boot). */
const { default: supabaseService } = await bootImport(
  "db/supabaseServiceClient",
  () => import("./db/supabaseServiceClient.js")
)

assertProductionEnvironmentOrExit()
logSupabaseKeyStatus()

if (supabaseService) {
  console.log("[boot] ✓ Supabase service client initialized (Storage)")
} else {
  console.warn(
    "[boot] Supabase service client not loaded (stub or set SUPABASE_URL + secret key when JS client is re-enabled)"
  )
}

const { default: express } = await bootImport("express", () => import("express"))
await import("express-async-errors")
const http = await bootImport("http", () => import("http"))
const fs = await bootImport("node:fs", () => import("node:fs"))
const path = await bootImport("path", () => import("path"))
const { fileURLToPath } = await bootImport("url", () => import("url"))
const { createRequire } = await bootImport("module", () => import("module"))
const require = createRequire(import.meta.url)
console.log("[boot] requiring socket.io...")
const { Server } = require("socket.io")
console.log("[boot] required socket.io")
const { default: pool } = await bootImport("db/db", () => import("./db/db.js"))

/* ==========================================
   ROUTES
========================================== */

let dashboardRoutes,
  queueRoutes,
  barberStatusRoutes,
  checkinRoutes,
  earningsRoutes,
  tipsRoutes,
  waitTimeRoutes,
  appointmentRoutes,
  testRoutes,
  voiceRoutes,
  bookingRoutes,
  buildAvailabilityPayload,
  barberStyleRoutes,
  paypalRoutes,
  adminRoutes,
  authRoutes,
  supabaseBridgeRoutes,
  notificationRoutes,
  paymentsRoutes,
  barberProfileApiRoutes,
  aboutRoutes,
  contactRoutes,
  aiRoutes

let requireAuth, attachTwilioRealtimeBridge, getAssistantReply, appendTurn, getHistory
attachTwilioRealtimeBridge = () => {}

const importDefault = async (label, path) => {
  console.log(`[boot] importing ${label}...`)
  const mod = await import(path)
  console.log(`[boot] imported ${label}`)
  return mod?.default ?? mod
}

const importNamed = async (label, path) => {
  console.log(`[boot] importing ${label}...`)
  const mod = await import(path)
  console.log(`[boot] imported ${label}`)
  return mod
}
const voiceFormBody = express.urlencoded({ extended: true })

function publicWebhookBaseUrl(req) {
  const configured = String(
    process.env.VOICE_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL || ""
  ).replace(/\/$/, "")
  if (configured) return configured
  return `${req.protocol}://${req.get("host")}`
}

let logStartupEnvDiagnostics = () => {}
try {
  const mod = await import("./config/envDiagnostics.js")
  if (typeof mod.logStartupEnvDiagnostics === "function") {
    logStartupEnvDiagnostics = mod.logStartupEnvDiagnostics
  }
} catch (err) {
  console.warn(
    "[boot] env diagnostics disabled (missing ./config/envDiagnostics.js):",
    (err && typeof err === "object" && "message" in err) ? err.message : err
  )
}

console.log("[boot] Loading route/service modules (import tracing enabled)...")

dashboardRoutes = await importDefault("routes/dashboardRoutes", "./routes/dashboardRoutes.js")
queueRoutes = await importDefault("routes/queueRoutes", "./routes/queueRoutes.js")
barberStatusRoutes = await importDefault("routes/barberStatusRoutes", "./routes/barberStatusRoutes.js")
checkinRoutes = await importDefault("routes/checkinRoutes", "./routes/checkinRoutes.js")
earningsRoutes = await importDefault("routes/earningsRoutes", "./routes/earningsRoutes.js")
tipsRoutes = await importDefault("routes/tipsRoutes", "./routes/tipsRoutes.js")
waitTimeRoutes = await importDefault("routes/waitTimeRoutes", "./routes/waitTimeRoutes.js")
appointmentRoutes = await importDefault("routes/appointments", "./routes/appointments.js")
testRoutes = await importDefault("routes/testRoutes", "./routes/testRoutes.js")
voiceRoutes = await importDefault("routes/voiceRoutes", "./routes/voiceRoutes.js")
{
  const bookingMod = await importNamed("routes/bookingRoutes", "./routes/bookingRoutes.js")
  bookingRoutes = bookingMod?.default ?? bookingMod
  buildAvailabilityPayload = bookingMod.buildAvailabilityPayload
}
barberStyleRoutes = await importDefault("routes/barberStyleRoutes", "./routes/barberStyleRoutes.js")
paypalRoutes = await importDefault("routes/paypalRoutes", "./routes/paypalRoutes.js")
adminRoutes = await importDefault("routes/adminRoutes", "./routes/adminRoutes.js")
try {
  authRoutes = await Promise.race([
    importDefault("routes/authRoutes", "./routes/authRoutes.js"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("authRoutes import timeout")), 5000)),
  ])
} catch (e) {
  console.warn(
    "[boot] auth routes disabled (failed to load):",
    e instanceof Error ? e.message : String(e)
  )
  authRoutes = express.Router()
  authRoutes.use((_req, res) => res.status(503).json({ ok: false, error: "auth_unavailable" }))
}
supabaseBridgeRoutes = await importDefault("routes/supabaseBridgeRoutes", "./routes/supabaseBridgeRoutes.js")
notificationRoutes = await importDefault("routes/notificationRoutes", "./routes/notificationRoutes.js")
paymentsRoutes = await importDefault("routes/paymentsRoutes", "./routes/paymentsRoutes.js")
barberProfileApiRoutes = await importDefault("routes/barberProfileApiRoutes", "./routes/barberProfileApiRoutes.js")
const uploadRoutes = await importDefault("routes/uploadRoutes", "./routes/uploadRoutes.js")
const verifyPaymentRoutes = await importDefault("routes/verifyPaymentRoutes", "./routes/verifyPaymentRoutes.js")
const paymentSuccessRoutes = await importDefault("routes/paymentSuccessRoutes", "./routes/paymentSuccessRoutes.js")
const { stylesRouter, imagesRouter } = await import("./routes/barberCmsRoutes.js")
aboutRoutes = await importDefault("routes/aboutRoutes", "./routes/aboutRoutes.js")
contactRoutes = await importDefault("routes/contactRoutes", "./routes/contactRoutes.js")
aiRoutes = await importDefault("routes/ai", "./routes/ai.js")

;({ requireAuth } = await importNamed("middleware/requireAuth", "./middleware/requireAuth.js"))
;({ getAssistantReply, appendTurn, getHistory } = await importNamed("services/aiService", "./services/aiService.js"))

const app = express()
const server = http.createServer(app)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let appVersion = "1.0.0"
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))
  if (pkg?.version) appVersion = String(pkg.version)
} catch {
  /* ignore */
}

/**
 * API-only mode: no `client/dist` static or SPA fallback — use Vite on :5174 for UI (`VITE_API_BASE` → this origin).
 * - Default in development (NODE_ENV !== production) unless `IFCDC_SERVE_SPA=1`.
 * - Production serves the built SPA unless `IFCDC_API_ONLY=1`.
 */
const explicitApiOnly = String(process.env.IFCDC_API_ONLY || "").trim() === "1"
const explicitServeSpa = String(process.env.IFCDC_SERVE_SPA || "").trim() === "1"
const beautySandboxServeClient = String(process.env.BEAUTY_SANDBOX_SERVE_CLIENT || "").trim() === "1"
const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production"
const apiOnly = explicitApiOnly || (!isProd && !explicitServeSpa && !beautySandboxServeClient)

app.set("trust proxy", true)

/** Global CORS — first middleware, before any route (Vite :5173/:5174/:5179, LAN, production SPA). */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD")
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, x-admin-key, X-Requested-With, X-Admin-Key, Cache-Control",
  )
  if (req.method === "OPTIONS") {
    return res.sendStatus(200)
  }
  next()
})

/** One-line access log for every request (set IFCDC_REQUEST_LOG=0 to disable). */
if (String(process.env.IFCDC_REQUEST_LOG ?? "1").trim() !== "0") {
  app.use((req, res, next) => {
    const started = Date.now()
    res.on("finish", () => {
      console.log(
        "[http]",
        res.statusCode,
        req.method,
        req.originalUrl || req.url,
        `${Date.now() - started}ms`,
      )
    })
    next()
  })
}

/**
 * JSON bodies for all routes except `/api/*` (apiRouter uses its own parser + PayPal rawBody).
 * Hoist one parser instance — do not call express.json() per request.
 */
const parseJsonExceptApi = express.json()
app.use((req, res, next) => {
  if (String(req.path || "").startsWith("/api")) return next()
  return parseJsonExceptApi(req, res, next)
})

/** Mobile app-bookings — mount immediately after global parsers (before other routes / catch-alls). */
let appBookingCheckoutRouter
try {
  appBookingCheckoutRouter = require(nodePath.join(__rootDir, "appBookingCheckoutRoutes.cjs"))
  console.log("[boot] loaded appBookingCheckoutRoutes.cjs")
} catch (err) {
  console.error(
    "[boot] FAILED to require appBookingCheckoutRoutes.cjs:",
    err instanceof Error ? err.message : String(err),
  )
  appBookingCheckoutRouter = express.Router()
  appBookingCheckoutRouter.get("/health", (_req, res) => {
    res.status(503).json({ ok: false, error: "app_bookings_router_load_failed" })
  })
}

app.get("/api/app-bookings/health", (_req, res) => {
  res.set("Cache-Control", "no-store")
  res.json({ ok: true })
})

app.use(
  "/api/app-bookings",
  express.json({
    limit: "512kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }),
  express.urlencoded({ extended: true }),
  appBookingCheckoutRouter,
)

console.log("[boot] mounted GET /api/app-bookings/health + USE /api/app-bookings/*")

/**
 * Root probe — JSON so browsers, curl, and uptime checks get a stable 200 (runs before SPA catch-all).
 * Matches legacy production shape for clients that already parse this payload.
 */
app.get("/", (_req, res) => {
  res.json({
    platform: "IFCDC Barbers Platform",
    status: "running",
    version: appVersion,
  })
})

app.get("/test", (_req, res) => {
  res.json({ success: true })
})

/** Minimal probe for load balancers / ops (also see GET /api/health). */
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

/**
 * IFCDC Vite client (`client/`) calls POST /bookings and GET /barbers at the host root — not /api/*.
 */
{
  const { createRequire } = await import("module")
  const require = createRequire(import.meta.url)
  const bookingRoutes = require("../bookingRoutesMinimal.cjs")
  app.use("/", bookingRoutes)
}
{
  const { mountMinimalIfcdcApi } = await import("../minimalIfcdcApi.js")
  mountMinimalIfcdcApi(app, {
    serveUploads: false,
    uploadDir: nodePath.join(__rootDir, "backend", "uploads"),
  })
}

/**
 * Login — IFCDC_LOGIN_BYPASS=1 skips credential check. Otherwise admin@ifcdc.com / 1234.
 */
app.post("/auth/login", (req, res) => {
  const { email: rawEmail, password: rawPassword } = req.body || {}
  console.log("[auth/login] request", {
    contentType: req.headers["content-type"],
    hasBody: req.body != null,
    email: rawEmail != null ? String(rawEmail).slice(0, 2) + "…" : "(missing)",
  })

  const successPayload = {
    success: true,
    user: {
      role: "admin",
      name: "Admin",
      email: "admin@ifcdc.com",
    },
    token: "dev-token",
  }

  const bypass = String(process.env.IFCDC_LOGIN_BYPASS || "").trim() === "1"
  if (bypass) {
    return res.json(successPayload)
  }

  const email = String(rawEmail || "").trim().toLowerCase()
  const password = String(rawPassword || "")
  if (email === "admin@ifcdc.com" && password === "1234") {
    return res.json(successPayload)
  }
  res.status(401).json({ success: false, message: "Invalid credentials" })
})

if (process.env.NODE_ENV !== "production") {
  console.log("[boot] ADMIN_SECRET:", process.env.ADMIN_SECRET?.trim() ? "set" : "missing (admin uploads will fail)")
}

const io = new Server(server, {
  cors: {
    origin: "*"
  }
})

if (String(process.env.ENABLE_REALTIME_VOICE || "").trim().toLowerCase() === "true") {
  console.log("[boot] ENABLE_REALTIME_VOICE=true — attaching Twilio realtime bridge")
  try {
    const mod = await Promise.race([
      import("./services/realtimeVoice.js"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("realtimeVoice import timeout")), 7000)),
    ])
    if (typeof mod.attachTwilioRealtimeBridge === "function") {
      mod.attachTwilioRealtimeBridge({
        server,
        path: "/api/voice/media-stream"
      })
    } else {
      console.warn("[boot] realtime voice bridge not available (missing export)")
    }
  } catch (err) {
    console.warn(
      "[boot] realtime voice bridge disabled (failed to load):",
      err instanceof Error ? err.message : String(err)
    )
  }
} else {
  console.log("[boot] realtime voice bridge disabled (set ENABLE_REALTIME_VOICE=true to enable)")
}

/* ==========================================
   PUBLIC ROUTES — Twilio Voice webhook: POST /voice (GET for browser checks)
   Raw TwiML only — no Twilio SDK dependency on this path (reliable on Render).
========================================== */

const VOICE_TWIML_WELCOME = `
<Response>
  <Say>Welcome to IFCDC</Say>
</Response>
`

app.get("/voice", (_req, res) => {
  res.type("text/xml")
  res.send(VOICE_TWIML_WELCOME.trim())
})

app.post("/voice", voiceFormBody, (req, res) => {
  res.type("text/xml")
  res.send(VOICE_TWIML_WELCOME.trim())
})

/* Optional public probe (no /api middleware stack) */
app.get("/api/health", async (_req, res) => {
  let db = { ok: false, error: null }
  try {
    await pool.query("SELECT 1")
    db.ok = true
  } catch (err) {
    db.error = String(err?.code || err?.message || "db_unreachable")
  }

  const publicBase =
    process.env.PUBLIC_BASE_URL?.trim()
    || process.env.RENDER_EXTERNAL_URL?.trim()
    || null

  res.json({
    ok: true,
    uptime: process.uptime(),
    /** Resolved base URL for Twilio webhooks (Render sets RENDER_EXTERNAL_URL). */
    publicBaseUrl: publicBase,
    supabaseBridge: Boolean(
      process.env.SUPABASE_URL?.trim()
      && resolveSupabaseSecretKey()
    ),
    db,
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
    twilio: Boolean(
      process.env.TWILIO_ACCOUNT_SID?.trim()
      && process.env.TWILIO_AUTH_TOKEN?.trim()
      && process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()
    ),
    twilioSignatureValidation: process.env.TWILIO_VALIDATE_SIGNATURE === "true",
    twilioWebhooks: {
      voiceRoot: "POST /voice → TwiML Say Welcome to IFCDC (set Voice webhook in Twilio to https://…/voice)",
      smsIncoming: "POST /api/sms/incoming",
      smsIncomingAlt: "POST /api/voice/sms-incoming",
      voiceIncomingCall: "POST /api/voice/incoming-call",
      voiceLegacyIncoming: "POST /api/voice/incoming (voiceRoutes.js)",
      voiceGatherEntry: "GET|POST /api/voice/voice",
      voiceProcess: "POST /api/voice/process",
      voiceStatus: "POST /api/voice/status"
    }
  })
})

/** Operational checklist (Phase 5 style) — no secrets. */
app.get("/api/health/readiness", async (_req, res) => {
  let database = "unknown"
  try {
    await pool.query("SELECT 1")
    database = "connected"
  } catch {
    database = "failed"
  }

  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim()
    && process.env.TWILIO_AUTH_TOKEN?.trim()
    && process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()
  )

  const publicBase =
    process.env.PUBLIC_BASE_URL?.trim()
    || process.env.RENDER_EXTERNAL_URL?.trim()
    || null

  const skipVite = String(process.env.SKIP_VITE_ENV_VALIDATION || "").toLowerCase() === "true"
  let viteEnv = "skipped"
  if (!skipVite) {
    const v = Boolean(
      process.env.VITE_SUPABASE_URL?.trim()
      && resolveViteSupabasePublishableKey()
      && process.env.VITE_ADMIN_API_KEY?.trim()
    )
    viteEnv = v ? "present" : "incomplete"
  }

  const adminSecretSet = Boolean(process.env.ADMIN_SECRET?.trim())
  const adminKeyAligned =
    !skipVite
    && adminSecretSet
    && String(process.env.VITE_ADMIN_API_KEY || "").trim() === String(process.env.ADMIN_SECRET || "").trim()

  res.json({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    database: database === "connected" ? "Connected" : "Failed",
    backend: "Running",
    supabaseService: supabaseService ? "Initialized" : "Failed",
    twilio: twilioConfigured ? "Configured" : "Incomplete",
    publicBaseUrl: publicBase || "missing",
    admin: adminSecretSet && (skipVite || adminKeyAligned) ? "Active" : adminSecretSet ? "Check VITE_ADMIN_API_KEY" : "Inactive",
    uploads: supabaseService && process.env.SUPABASE_STORAGE_BUCKET === "barber-styles" ? "Ready" : "Check bucket env",
    viteEnv,
    voiceWebhookHint: publicBase ? `POST ${publicBase.replace(/\/$/, "")}/voice` : "Set PUBLIC_BASE_URL or deploy on Render",
  })
})

/** Local style photo uploads (when Supabase Storage is not configured). */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")))

/* ==========================================
   /api only — body parsers + route mounts
   requireAdmin, Twilio signature checks, etc. live on routers below (never on `app`).
========================================== */

const apiRouter = express.Router()

apiRouter.use(express.json({
  verify: (req, _res, buf) => {
    // Needed for PayPal webhook signature verification.
    // Only used by webhook handler; safe for all other JSON routes.
    req.rawBody = buf
  }
}))
apiRouter.use(express.urlencoded({ extended: true }))

// Push notifications (simple in-memory store)
const pushTokens = new Set()

apiRouter.post("/push/register", async (req, res) => {
  const token = String(req.body?.token || "").trim()
  if (!token) {
    res.status(400).json({ ok: false, error: "token_required" })
    return
  }
  pushTokens.add(token)
  res.json({ ok: true, count: pushTokens.size })
})

/** GET|POST /api/test-email — Resend (aligned with root `server.js`). */
{
  const { createRequire } = await import("module")
  const path = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const require = createRequire(import.meta.url)
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
  const { getResend, getMailFrom, sendEmail } = require(path.join(rootDir, "emailResend.cjs"))

  async function runApiTestEmail(to, res) {
    console.log(
      "[EMAIL] test-email: RESEND_API_KEY:",
      getResend() ? "LOADED" : "MISSING",
      "MAIL_FROM:",
      getMailFrom() || "MISSING"
    )
    const result = await sendEmail({
      to,
      subject: "IFCDC System Test",
      html: "<p>IFCDC transactional email test ✅</p>",
      label: "test-email",
    })
    if (result.error) {
      const msg = result.error.message || String(result.error)
      console.error("[EMAIL ERROR]", msg)
      const isConfig = /RESEND_API_KEY|MAIL_FROM/i.test(msg)
      return res.status(isConfig ? 503 : 200).json({ success: false, error: msg })
    }
    return res.json({ success: true, to, messageId: result?.data?.id ?? null })
  }

  apiRouter.get("/test-email", async (req, res) => {
    const to = String(req.query.to || req.query.email || "").trim()
    if (!to) {
      return res.status(400).json({
        success: false,
        error: "to_required",
        message: "Use GET /api/test-email?to=you@example.com",
      })
    }
    return runApiTestEmail(to, res)
  })

  apiRouter.post("/test-email", async (req, res) => {
    const to = String(req.body?.to || req.query?.to || "").trim()
    if (!to) {
      return res.status(400).json({
        success: false,
        error: "to_required",
        message: 'Send JSON { "to": "you@example.com" }',
      })
    }
    return runApiTestEmail(to, res)
  })
}

apiRouter.post("/push/test", async (req, res) => {
  const token = String(req.body?.token || "").trim()
  const to = token || [...pushTokens][0] || null

  if (!to) {
    res.status(400).json({ ok: false, error: "no_token_registered" })
    return
  }

  try {
    const payload = {
      to,
      sound: "default",
      title: "IFCDC Barbers",
      body: "Test push notification",
      data: { kind: "test_push" },
    }

    const resp = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    const json = await resp.json()
    res.json({ ok: true, to, result: json })
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

apiRouter.post("/chat", requireAuth, async (req, res) => {
  const conversationId = String(req.body?.conversationId || "mobile-chat")
  const message = String(req.body?.message || "").trim()

  if (!message) {
    res.status(400).json({ ok: false, error: "message_required" })
    return
  }

  try {
    appendTurn(conversationId, "user", message)
    const { reply, used } = await getAssistantReply({ conversationId, message })
    appendTurn(conversationId, "assistant", reply)
    res.json({ ok: true, reply, used, history: getHistory(conversationId) })
  } catch (err) {
    res.json({
      ok: true,
      reply: "Sorry—I’m having trouble right now. Please try again in a moment.",
      used: "fallback_error",
      history: getHistory(conversationId)
    })
  }
})

// Public AURA chat (shared for web + mobile; no auth required).
apiRouter.post("/aura/chat", async (req, res) => {
  const conversationId = String(req.body?.conversationId || "aura-web").trim() || "aura-web"
  const message = String(req.body?.message || "").trim()

  if (!message) {
    res.status(400).json({ ok: false, error: "message_required" })
    return
  }

  try {
    appendTurn(conversationId, "user", message)
    const { reply, used } = await getAssistantReply({ conversationId, message })
    appendTurn(conversationId, "assistant", reply)
    res.json({ ok: true, reply, used, history: getHistory(conversationId) })
  } catch (err) {
    console.error("[aura] chat error:", err)
    res.json({
      ok: true,
      reply: "Sorry—I’m having trouble right now. Please try again in a moment.",
      used: "fallback_error",
      history: getHistory(conversationId)
    })
  }
})

// POST /api/ai/chat — handled by routes/ai.js (OpenAI Aura); do not register a duplicate handler here.

// GET /api/availability — no query → JSON array of slots (smoke test in browser).
// GET /api/availability?date=YYYY-MM-DD&barber=NAME — full object with availableTimes, nextAvailable, etc.
const PUBLIC_AVAILABILITY_SLOTS = [
  "09:00 AM",
  "10:00 AM",
  "11:00 AM",
  "12:00 PM",
  "01:00 PM",
  "02:00 PM",
  "03:00 PM",
  "04:00 PM",
]

apiRouter.get("/availability", (req, res) => {
  const date = String(req.query?.date || "").trim()
  if (!date) {
    res.json(PUBLIC_AVAILABILITY_SLOTS)
    return
  }
  if (typeof buildAvailabilityPayload !== "function") {
    res.status(500).json({ ok: false, error: "availability_unavailable" })
    return
  }
  const payload = buildAvailabilityPayload(req.query)
  if (payload.error) {
    res.status(payload.status).json(payload.body)
    return
  }
  res.json(payload.body)
})

// POST /api/create-order — PayPal Smart Buttons: returns { orderId } from Orders API (needs PAYPAL_* env)
apiRouter.post("/create-order", async (req, res) => {
  try {
    const { createPayPalOrderForButtons } = await import("./services/paypalService.js")
    const amount = Number(req.body?.amount)
    const n = Number.isFinite(amount) && amount > 0 ? amount : 20
    const customId = String(req.body?.customId || "checkout").slice(0, 127)
    const data = await createPayPalOrderForButtons(n, customId)
    res.json({ orderId: data.id })
  } catch (err) {
    console.error("[api] create-order:", err)
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

// POST /api/create-paypal-order — redirect flow (full-page PayPal); returns { approvalUrl, orderId }
apiRouter.post("/create-paypal-order", async (req, res) => {
  try {
    const { createPayPalRedirectOrder } = await import("./services/paypalService.js")
    const amount = Number(req.body?.amount)
    const base =
      String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "").trim()
      || `${req.protocol}://${req.get("host")}`
    const returnUrl = `${base}/`
    const cancelUrl = `${base}/?paypal_cancel=1`
    const customId =
      String(req.body?.customId || "").trim()
      || [req.body?.barber, req.body?.date, req.body?.time, String(amount || "")]
        .map((x) => (x == null ? "" : String(x)))
        .filter(Boolean)
        .join("|")
        .slice(0, 127)
    const { approvalUrl, orderId } = await createPayPalRedirectOrder({
      amount,
      currency: "USD",
      customId,
      returnUrl,
      cancelUrl,
    })
    res.json({ ok: true, approvalUrl, orderId })
  } catch (err) {
    console.error("[api] create-paypal-order:", err)
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

// Repo-root `authRoutes.js` (Postgres `app_users`, mobile JWT) — must be first so `/api/auth/*` is not only the legacy `src/routes/authRoutes` (Supabase `users` table).
try {
  const { sendEmail } = require("../emailResend.cjs")
  const { createAuthRouter } = await import("../authRoutes.js")
  const platformAppUsersAuth = createAuthRouter({ sendEmail })
  apiRouter.use("/auth", platformAppUsersAuth)
  console.log("[boot] mounted /api/auth (root authRoutes.js — app_users)")
} catch (err) {
  console.warn(
    "[boot] root authRoutes.js not mounted on /api/auth:",
    err instanceof Error ? err.message : String(err),
  )
}

apiRouter.use("/auth", authRoutes)
apiRouter.use("/auth", supabaseBridgeRoutes)
apiRouter.use("/dashboard", dashboardRoutes)
apiRouter.use("/queue", queueRoutes)
apiRouter.use("/barber-status", barberStatusRoutes)
apiRouter.use(checkinRoutes)
apiRouter.use("/bookings", bookingRoutes)
apiRouter.use("/barbers", barberStyleRoutes)
apiRouter.use("/barbers", barberProfileApiRoutes)
apiRouter.use("/styles", stylesRouter)
apiRouter.use("/images", imagesRouter)
apiRouter.use("/upload", uploadRoutes)
apiRouter.use("/verify-payment", verifyPaymentRoutes)
apiRouter.use("/payment-success", paymentSuccessRoutes)
apiRouter.use("/about", aboutRoutes)
apiRouter.use("/contact", contactRoutes)
apiRouter.use("/ai", aiRoutes)
apiRouter.use("/appointments", appointmentRoutes)
apiRouter.use("/paypal", paypalRoutes)
apiRouter.use("/notifications", notificationRoutes)
apiRouter.use("/payments", paymentsRoutes)
apiRouter.use("/earnings", earningsRoutes)
apiRouter.use("/tips", tipsRoutes)
apiRouter.use("/wait-time", waitTimeRoutes)
apiRouter.use("/test", testRoutes)
apiRouter.use("/admin", adminRoutes)
try {
  const { default: receptionistRoutes } = await import("./routes/receptionistRoutes.js")
  apiRouter.use("/receptionist", receptionistRoutes)
} catch (err) {
  console.warn(
    "[boot] receptionist routes disabled (missing ./routes/receptionistRoutes.js):",
    (err && typeof err === "object" && "message" in err) ? err.message : err
  )
}
try {
  const { default: voiceAiRoutes } = await import("../server/routes/voice.ts")
  apiRouter.use("/voice", voiceAiRoutes)
} catch (err) {
  console.warn(
    "[boot] voice AI routes disabled (failed to load ../server/routes/voice.ts):",
    (err && typeof err === "object" && "message" in err) ? err.message : err
  )
}
apiRouter.use("/voice", voiceRoutes)

/** JSON 404 for unknown `/api/*` (avoids HTML error pages on API paths). */
apiRouter.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", message: `No API handler for ${req.method} ${req.originalUrl || req.path}` })
})

app.use("/api", apiRouter)

/** Must sit directly after `/api` mount: catches `next(err)` from async routes (express-async-errors). */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const isApi =
    String(req.originalUrl || "").startsWith("/api")
    || req.baseUrl === "/api"
    || String(req.url || "").startsWith("/api")
  if (isApi) {
    console.error("[api] unhandled error:", err)
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    })
  }
  return next(err)
})

app.use("/admin", express.static(path.join(__dirname, "public")))

/** Built SPA: Vite → client/dist; optional CRA-style client/build. */
const resolveClientDistDir = () => {
  const fromEnv = process.env.CLIENT_DIST_PATH?.trim()
  if (fromEnv) {
    const abs = path.resolve(fromEnv)
    if (fs.existsSync(path.join(abs, "index.html"))) return abs
  }
  const candidates = [
    path.join(__dirname, "..", "client", "dist"),
    path.join(process.cwd(), "client", "dist"),
    path.join(__dirname, "..", "client", "build"),
    path.join(process.cwd(), "client", "build"),
    path.join(process.cwd(), "dist"),
    path.join(process.cwd(), "build"),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir
  }
  return path.join(__dirname, "..", "client", "dist")
}

const clientDistDir = resolveClientDistDir()
const clientIndexHtml = path.join(clientDistDir, "index.html")
const clientBuildReady = fs.existsSync(clientIndexHtml)

if (clientBuildReady && !apiOnly) {
  app.use(express.static(clientDistDir, { index: "index.html", fallthrough: true }))
}

/* ==========================================
   DATABASE CONNECTION
========================================== */

pool.connect()
  .then((client) => {
    client.release()
    console.log("Database connected")
  })
  .catch(err => {
    const code = String(err?.code || "")
    const host = String(err?.hostname || err?.host || "")
    const detail = err?.message || String(err)
    console.error("IFCDC Database connection failed:", detail)
    if (code) console.error("   PostgreSQL error code:", code)
    if (host) console.error("   Host:", host)

    if (code === "ENOTFOUND") {
      console.error("   Fix: Check DATABASE_URL pooler hostname (ends with .pooler.supabase.com) and DNS/network.")
      console.error("   Use the exact host from Supabase → Project Settings → Database → Connection string (pooler).")
    } else if (code === "28P01") {
      console.error(
        "   Fix: Database password does not match (or pooler user is wrong). Postgres often reports user \"postgres\" in this error even when you use postgres.<project-ref> in the URI."
      )
      console.error(
        "   In Supabase: Project Settings → Database → Database password → reset if unsure, then copy the Transaction pooler URI (port 6543) or Session pooler (5432) as a single DATABASE_URL line."
      )
      console.error("   Pooler username must be postgres.<your-project-ref>, not postgres alone. No spaces or quotes around the URL in .env.")
    } else if (code === "ECONNREFUSED") {
      console.error("   Fix: Confirm pooler host, port 6543 (transaction) or 5432 (session per dashboard), and sslmode=require.")
      console.error("   Prefer pooler hostname over db.<project>.supabase.co if direct connection is unstable.")
    } else {
      console.error("   Fix: Verify DATABASE_URL (single entry), restart the server after .env changes.")
    }
  })

/* ==========================================
   SOCKET.IO REALTIME ENGINE
========================================== */

io.on("connection", (socket) => {

  console.log("⚡ Client connected")

  socket.on("joinBarberRoom", (barberId) => {
    socket.join(`barber-${barberId}`)
  })

  socket.on("disconnect", () => {
    console.log("Client disconnected")
  })

})

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"))
})

const spaFallbackHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>IFCDC Barbers</title></head><body><h1>IFCDC Website is Live</h1><p>Web build not found. From the repo root run: <code>npm run build</code> (creates <code>client/dist</code> or <code>client/build</code>).</p></body></html>`

/** SPA: hash routes + deep links — serve React `index.html` for non-API GET/HEAD. */
function spaIndexFallback(req, res, next) {
  const p = req.path || ""
  /** Belt-and-suspenders: if route order regresses, still return probes (not index.html). */
  if (p === "/health") return res.json({ status: "ok" })
  if (p === "/test") return res.json({ success: true })
  if (p === "/api/app-bookings/health") {
    res.set("Cache-Control", "no-store")
    return res.json({ ok: true })
  }
  if (p === "/voice") {
    res.type("text/xml")
    return res.send(VOICE_TWIML_WELCOME.trim())
  }
  if (p.startsWith("/api")) return next()
  if (!beautySandboxServeClient && (p === "/admin" || p.startsWith("/admin/"))) return next()
  if (clientBuildReady) {
    res.sendFile(path.resolve(clientIndexHtml))
    return
  }
  res.status(200).type("html").send(spaFallbackHtml)
}
app.get("*", spaIndexFallback)
app.head("*", spaIndexFallback)

/* ==========================================
   SERVER START
========================================== */

const PORT = Number(process.env.PORT) || 10000

// Bind all interfaces so phones / LAN can reach the API (not localhost-only).
server.listen(PORT, "0.0.0.0", () => {
  try {
    const stack = app?._router?.stack
    if (Array.isArray(stack)) {
      const summary = stack
        .map((layer) => {
          if (layer?.route?.path != null) {
            const m = layer.route.methods || {}
            const verbs = Object.keys(m)
              .filter((k) => m[k])
              .join(",")
              .toUpperCase()
            return `${verbs} ${layer.route.path}`
          }
          if (layer?.name === "router") return "USE<Router>"
          return layer?.name ? `mw:${layer.name}` : "mw"
        })
        .filter(Boolean)
      console.log("[boot] Express stack (trimmed):", summary.slice(0, 100).join(" | "))
    }
  } catch (e) {
    console.warn("[boot] route stack log skipped:", e instanceof Error ? e.message : String(e))
  }

  console.log(`Server running on port ${PORT}`)
  console.log(`Backend running on http://0.0.0.0:${PORT}`)
  console.log(`Listening: http://0.0.0.0:${PORT} (network open)`)
  if (apiOnly) {
    console.log("[boot] API-only mode — not serving client/dist (use Vite on :5174; set IFCDC_SERVE_SPA=1 to serve SPA from this port in dev)")
  } else if (clientBuildReady) {
    console.log(`[boot] Website static: ${clientDistDir}`)
  } else {
    console.warn("[boot] Website build missing — run `npm run build` from repo root (outputs client/dist)")
  }
  logStartupEnvDiagnostics()
  console.log("[boot] Hot-reload: run `npm run dev` (nodemon watches src/ + server/)")
})

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use.`)
    console.error(`Run: lsof -ti:${PORT} | xargs kill -9`)
    process.exit(1)
  }

  console.error("❌ Server startup error:", error)
  process.exit(1)
})

let isShuttingDown = false

/** Close HTTP + Socket.IO + DB pool so the port is free (used by SIGTERM and nodemon SIGUSR2). */
const closeListeningSockets = async () => {
  await new Promise((resolve) => {
    server.close(() => resolve())
  }).catch(() => {})

  try {
    await io.close()
  } catch {
    /* ignore */
  }

  try {
    await pool.end()
  } catch {
    /* ignore */
  }
}

const isIgnorableShutdownError = (error) => {
  const code = String(error?.code || "")
  const message = String(error?.message || "")
  return (
    code === "ECONNRESET"
    || /connection terminated unexpectedly/i.test(message)
    || /read econreset/i.test(message)
  )
}

const shutdown = async (signal = "SIGTERM") => {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`)

  try {
    await closeListeningSockets()
  } catch (error) {
    console.error("Error while closing server resources:", error)
  }

  console.log("✅ Shutdown complete")
  process.exit(0)
}

/**
 * Nodemon’s default restart signal is SIGUSR2 (see nodemon defaults).
 * If we don’t close `server` here, the old process keeps the bound port and the
 * new child exits with EADDRINUSE — “[nodemon] app crashed”.
 */
process.once("SIGUSR2", () => {
  void (async () => {
    console.log("\n[nodemon] SIGUSR2 — releasing port before restart...")
    try {
      await closeListeningSockets()
    } catch (error) {
      console.error("[nodemon] cleanup error:", error)
    }
    process.kill(process.pid, "SIGUSR2")
  })()
})

process.on("SIGINT", () => {
  shutdown("SIGINT")
})

process.on("SIGTERM", () => {
  shutdown("SIGTERM")
})

process.on("uncaughtException", (error) => {
  if (isShuttingDown && isIgnorableShutdownError(error)) {
    return
  }

  console.error("❌ Uncaught exception:", error)
  shutdown("uncaughtException")
})

process.on("unhandledRejection", (reason) => {
  if (isShuttingDown && isIgnorableShutdownError(reason)) {
    return
  }

  console.error("❌ Unhandled rejection:", reason)
  shutdown("unhandledRejection")
})
