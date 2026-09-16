/**
 * Allowlisted Voicebox edge for Cloudflare Tunnel.
 * Binds 127.0.0.1 only. Does not expose Voicebox admin, filesystem, or docs.
 * No child_process. No arbitrary file I/O. Auth required on every route.
 */

const http = require("http");
const { URL } = require("url");
const {
  voiceboxTunnelSecret,
  verifyVoiceboxTunnelRequest,
  sanitizeLog,
} = require("./auraVoiceboxTunnelAuth.cjs");

const DEFAULT_UPSTREAM = "http://127.0.0.1:17493";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17494;
const MAX_BODY = 256 * 1024;
const GENERATE_KEYS = [
  "profile_id",
  "text",
  "language",
  "seed",
  "model_size",
  "instruct",
  "engine",
  "personality",
  "max_chunk_chars",
  "crossfade_ms",
  "normalize",
];

const AURA_PROFILE_NAMES = new Set([
  "AURA — FOUNDER APPROVED V1",
  "AURA - FOUNDER APPROVED V1",
  "AURA FOUNDER APPROVED V1",
]);

const rateBuckets = new Map();

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function proxyConfig(overrides = {}) {
  return {
    upstream: String(overrides.upstream || process.env.VOICEBOX_UPSTREAM_URL || DEFAULT_UPSTREAM)
      .trim()
      .replace(/\/$/, ""),
    host: String(overrides.host || process.env.VOICEBOX_TUNNEL_PROXY_HOST || DEFAULT_HOST).trim(),
    port: Number(overrides.port || process.env.VOICEBOX_TUNNEL_PROXY_PORT || DEFAULT_PORT),
    secret: overrides.secret || voiceboxTunnelSecret(),
    healthTimeoutMs: Math.max(300, envNum("VOICEBOX_HEALTH_TIMEOUT_MS", 2000)),
    speakLimit: Math.max(5, envNum("VOICEBOX_TUNNEL_SPEAK_LIMIT", 20)),
    healthLimit: Math.max(10, envNum("VOICEBOX_TUNNEL_HEALTH_LIMIT", 60)),
    windowMs: Math.max(5000, envNum("VOICEBOX_TUNNEL_RATE_WINDOW_MS", 60_000)),
    timeoutMs: Math.max(3000, Number(overrides.timeoutMs || process.env.VOICEBOX_TIMEOUT_MS || 20000)),
    now: overrides.now,
    fetchImpl: overrides.fetchImpl || null,
  };
}

function matchRoute(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  const p = String(pathname || "");
  if (p.includes("..") || p.includes("%2e") || p.includes("%2E") || p.includes("\0")) return null;
  if (m === "GET" && (p === "/health" || p === "/ready")) return "health";
  if (m === "GET" && p === "/models/status") return "health";
  if (m === "GET" && p === "/profiles") return "profiles_read";
  if (m === "POST" && (p === "/generate" || p === "/generate/stream" || p === "/speak")) return "speak";
  if (m === "GET" && /^\/generate\/[A-Za-z0-9_-]+\/status$/.test(p)) return "speak";
  if (m === "POST" && /^\/generate\/[A-Za-z0-9_-]+\/cancel$/.test(p)) return "speak";
  if (m === "GET" && /^\/audio\/[A-Za-z0-9_-]+$/.test(p)) return "speak";
  if (m === "GET" && /^\/history\/[A-Za-z0-9_-]+$/.test(p)) return "speak";
  return null;
}

function clientKey(req) {
  const h = req.headers || {};
  const cf = String(h["cf-connecting-ip"] || "").split(",")[0].trim();
  if (cf) return cf;
  const xff = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  if (xff) return xff;
  return String(req.socket?.remoteAddress || "unknown");
}

function takeToken(key, className, cfg) {
  const limit = className === "speak" ? cfg.speakLimit : cfg.healthLimit;
  const now = cfg.now ? cfg.now() : Date.now();
  const bucketKey = `${key}:${className}`;
  let row = rateBuckets.get(bucketKey);
  if (!row || now - row.start >= cfg.windowMs) row = { start: now, count: 0 };
  row.count += 1;
  rateBuckets.set(bucketKey, row);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start >= cfg.windowMs) rateBuckets.delete(k);
    }
  }
  return row.count <= limit;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body_too_large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeGenerateJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || "{}"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = {};
  for (const key of GENERATE_KEYS) {
    if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  if (typeof out.text === "string") out.text = out.text.slice(0, 4000);
  if (typeof out.instruct === "string") out.instruct = out.instruct.slice(0, 500);
  return out;
}

function isAuraProfile(row) {
  const name = String(row?.name || "");
  if (AURA_PROFILE_NAMES.has(name)) return true;
  if (/^AURA/.test(name) && /FOUNDER APPROVED/i.test(name) && !/ALLAH/i.test(name)) return true;
  return false;
}

function sanitizeHealth(upstream) {
  const src = upstream && typeof upstream === "object" ? upstream : {};
  const status = String(src.status || "").toLowerCase() === "healthy" ? "healthy" : "unhealthy";
  return {
    status,
    ok: status === "healthy",
    online: status === "healthy",
    model_loaded: Boolean(src.model_loaded),
    backend_type: src.backend_type || null,
    backend_variant: src.backend_variant || null,
    gpu_available: Boolean(src.gpu_available),
    service: "aura-voicebox-tunnel",
    productionActivation: "OFF",
    voiceboxPrimary: 0,
  };
}

function filterProfiles(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows.filter(isAuraProfile).map((row) => ({
    id: row.id,
    name: row.name,
    voice_type: row.voice_type,
    preset_engine: row.preset_engine,
    preset_voice_id: row.preset_voice_id,
    default_engine: row.default_engine,
    language: row.language,
  }));
}

function sanitizeModels(body) {
  const models = Array.isArray(body?.models) ? body.models : [];
  return {
    models: models.map((m) => ({
      model_name: m.model_name,
      downloaded: Boolean(m.downloaded),
      loaded: Boolean(m.loaded),
      display_name: m.display_name || m.model_name,
    })),
  };
}

async function upstreamJson(cfg, method, pathname, { json, timeoutMs } = {}) {
  if (typeof cfg.fetchImpl === "function") {
    const res = await cfg.fetchImpl(cfg.upstream + pathname, {
      method,
      headers: json ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
      body: json ? JSON.stringify(json) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  }
  const u = new URL(cfg.upstream + pathname);
  const payload = json ? Buffer.from(JSON.stringify(json)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          Host: u.host,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
        timeout: timeoutMs || cfg.healthTimeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(new Error("upstream_timeout"), { code: "timeout" }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function pipeUpstream(cfg, req, res, { method, pathname, bodyBuf }) {
  if (typeof cfg.fetchImpl === "function") {
    return (async () => {
      const started = Date.now();
      const headers = { Accept: req.headers.accept || "*/*" };
      if (bodyBuf && bodyBuf.length) {
        headers["Content-Type"] = req.headers["content-type"] || "application/json";
      }
      const up = await cfg.fetchImpl(cfg.upstream + pathname, {
        method,
        headers,
        body: bodyBuf && bodyBuf.length ? bodyBuf : undefined,
      });
      const buf = Buffer.from(await up.arrayBuffer());
      const ct = up.headers.get?.("content-type") || "application/octet-stream";
      res.writeHead(up.status, {
        "Content-Type": ct,
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
      });
      res.end(buf);
      console.log("[aura/voicebox-proxy]", method, pathname, up.status, `${Date.now() - started}ms`);
    })().catch((e) => {
      console.warn("[aura/voicebox-proxy] upstream", sanitizeLog(e?.message || e));
      if (!res.headersSent) sendJson(res, 502, { ok: false, online: false, error: "upstream_down" });
    });
  }

  const u = new URL(cfg.upstream + pathname);
  const started = Date.now();
  const headers = {
    Host: u.host,
    Accept: req.headers.accept || "*/*",
  };
  if (bodyBuf && bodyBuf.length) {
    headers["Content-Type"] = req.headers["content-type"] || "application/json";
    headers["Content-Length"] = bodyBuf.length;
  }
  const up = http.request(
    {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      headers,
      timeout: cfg.timeoutMs,
    },
    (upRes) => {
      const outHeaders = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      const ct = upRes.headers["content-type"];
      if (ct) outHeaders["Content-Type"] = ct;
      if (upRes.headers["content-length"]) outHeaders["Content-Length"] = upRes.headers["content-length"];
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
      upRes.on("end", () => {
        console.log("[aura/voicebox-proxy]", method, pathname, upRes.statusCode, `${Date.now() - started}ms`);
      });
    },
  );
  up.on("error", (e) => {
    console.warn("[aura/voicebox-proxy] upstream", sanitizeLog(e?.message || e));
    if (!res.headersSent) sendJson(res, 502, { ok: false, online: false, error: "upstream_down" });
  });
  up.on("timeout", () => {
    up.destroy();
    if (!res.headersSent) sendJson(res, 504, { ok: false, online: false, error: "upstream_timeout" });
  });
  if (bodyBuf && bodyBuf.length) up.write(bodyBuf);
  up.end();
}

function createProxyHandler(overrides = {}) {
  const cfg = proxyConfig(overrides);
  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = String(req.method || "GET").toUpperCase();
    const pathname = url.pathname;
    const route = matchRoute(method, pathname);
    if (!route) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    if (!takeToken(clientKey(req), route === "speak" ? "speak" : "health", cfg)) {
      sendJson(res, 429, { ok: false, error: "rate_limited" });
      return;
    }

    let bodyBuf = Buffer.alloc(0);
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        bodyBuf = await readBody(req);
      } catch (e) {
        sendJson(res, e?.code === "body_too_large" ? 413 : 400, { ok: false, error: "bad_body" });
        return;
      }
    }

    const auth = verifyVoiceboxTunnelRequest({
      secret: cfg.secret,
      method,
      path: pathname + url.search,
      body: bodyBuf,
      headers: req.headers,
    });
    if (!auth.ok) {
      console.warn("[aura/voicebox-proxy] auth", auth.reason, `${Date.now() - started}ms`);
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (pathname === "/health" || pathname === "/ready") {
      try {
        const up = await upstreamJson(cfg, "GET", "/health");
        const health = sanitizeHealth(up.body);
        if (!up.ok || !health.ok) {
          sendJson(res, 503, { ...health, ok: false, online: false, reachable: up.ok });
          return;
        }
        sendJson(res, 200, {
          ...health,
          ok: true,
          online: true,
          reachable: true,
          ready: pathname === "/ready" ? true : undefined,
        });
      } catch (e) {
        console.warn("[aura/voicebox-proxy] health", sanitizeLog(e?.message || e));
        sendJson(res, 503, { ok: false, online: false, reachable: false, status: "down", error: "voicebox_down" });
      }
      return;
    }

    if (pathname === "/models/status") {
      try {
        const up = await upstreamJson(cfg, "GET", "/models/status");
        if (!up.ok) {
          sendJson(res, 502, { ok: false, online: false, error: "upstream_down" });
          return;
        }
        sendJson(res, 200, sanitizeModels(up.body));
      } catch (e) {
        console.warn("[aura/voicebox-proxy] models", sanitizeLog(e?.message || e));
        sendJson(res, 502, { ok: false, online: false, error: "upstream_down" });
      }
      return;
    }

    if (pathname === "/profiles") {
      try {
        const up = await upstreamJson(cfg, "GET", "/profiles");
        if (!up.ok) {
          sendJson(res, 502, { ok: false, online: false, error: "upstream_down" });
          return;
        }
        sendJson(res, 200, filterProfiles(up.body));
      } catch (e) {
        console.warn("[aura/voicebox-proxy] profiles", sanitizeLog(e?.message || e));
        sendJson(res, 502, { ok: false, online: false, error: "upstream_down" });
      }
      return;
    }

    if (method === "POST" && (pathname === "/generate" || pathname === "/generate/stream" || pathname === "/speak")) {
      const filtered = sanitizeGenerateJson(bodyBuf);
      if (!filtered || !filtered.text) {
        sendJson(res, 400, { ok: false, error: "invalid_generate" });
        return;
      }
      bodyBuf = Buffer.from(JSON.stringify(filtered));
    }

    pipeUpstream(cfg, req, res, { method, pathname: pathname + url.search, bodyBuf });
  };
}

function startVoiceboxTunnelProxy(overrides = {}) {
  const cfg = proxyConfig(overrides);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    throw new Error("voicebox_proxy_must_bind_loopback");
  }
  if (!cfg.secret) {
    console.warn("[aura/voicebox-proxy] VOICEBOX_TUNNEL_SECRET missing — refusing to listen");
    throw new Error("voicebox_tunnel_secret_missing");
  }
  const handler = createProxyHandler(cfg);
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      console.warn("[aura/voicebox-proxy] handler", sanitizeLog(e?.message || e));
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "proxy_error" });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      console.log(
        JSON.stringify({
          event: "listen",
          bind: `http://${cfg.host}:${cfg.port}`,
          upstream: cfg.upstream,
          productionActivation: "OFF",
          voiceboxPrimary: 0,
        }),
      );
      resolve(server);
    });
  });
}

function resetProxyRateLimitsForTests() {
  rateBuckets.clear();
}

module.exports = {
  matchRoute,
  createProxyHandler,
  startVoiceboxTunnelProxy,
  sanitizeHealth,
  filterProfiles,
  sanitizeGenerateJson,
  resetProxyRateLimitsForTests,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM,
};

if (require.main === module) {
  startVoiceboxTunnelProxy().catch((e) => {
    console.error("[aura/voicebox-proxy] fatal", sanitizeLog(e?.message || e));
    process.exit(1);
  });
}
