/**
 * Thin HTTP client for the Voicebox 0.5.0 API discovered on the Founder Mac
 * (127.0.0.1:17493). Only endpoints from GET /openapi.json. No invented APIs.
 */

const { voiceboxFlags } = require("./auraVoiceboxFlags.cjs");
const { signVoiceboxTunnelRequest, voiceboxUsesTunnelAuth, voiceboxTunnelSecret } = require("./auraVoiceboxTunnelAuth.cjs");

function defaultFetch() {
  return globalThis.fetch.bind(globalThis);
}

function joinUrl(base, p) {
  const path = p.startsWith("/") ? p : `/${p}`;
  return `${String(base).replace(/\/$/, "")}${path}`;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer), abort: () => ctrl.abort() };
}

async function parseBody(res) {
  const ct = String(res.headers.get("content-type") || "");
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  if (ct.includes("text/event-stream")) {
    return { _sse: true, text: await res.text() };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function tunnelHeaders(method, path, body, flags) {
  const base = flags?.baseUrl;
  if (!voiceboxUsesTunnelAuth(base)) return {};
  const secret = voiceboxTunnelSecret();
  if (!secret) return {};
  return signVoiceboxTunnelRequest({ secret, method, path, body });
}

function createVoiceboxClient(opts = {}) {
  const fetchImpl = opts.fetch || defaultFetch();
  const flags = () => ({ ...voiceboxFlags(), ...(opts.flags || {}) });

  async function request(method, path, { json, timeoutMs, headers } = {}) {
    const f = flags();
    const t = withTimeout(timeoutMs || f.timeoutMs);
    const rawBody = json ? JSON.stringify(json) : undefined;
    try {
      const res = await fetchImpl(joinUrl(f.baseUrl, path), {
        method,
        headers: {
          Accept: "application/json",
          ...(json ? { "Content-Type": "application/json" } : {}),
          ...tunnelHeaders(method, path, rawBody, f),
          ...(headers || {}),
        },
        body: rawBody,
        signal: t.signal,
      });
      const body = await parseBody(res);
      if (!res.ok) {
        const err = new Error(`voicebox_${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    } finally {
      t.cancel();
    }
  }

  async function requestBinary(method, path, { json, timeoutMs } = {}) {
    const f = flags();
    const t = withTimeout(timeoutMs || f.timeoutMs);
    const rawBody = json ? JSON.stringify(json) : undefined;
    try {
      const res = await fetchImpl(joinUrl(f.baseUrl, path), {
        method,
        headers: {
          Accept: "audio/wav, audio/mpeg, application/octet-stream, application/json",
          ...(json ? { "Content-Type": "application/json" } : {}),
          ...tunnelHeaders(method, path, rawBody, f),
        },
        body: rawBody,
        signal: t.signal,
      });
      const ct = String(res.headers.get("content-type") || "");
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const err = new Error(`voicebox_${res.status}`);
        err.status = res.status;
        err.body = ct.includes("json") ? buf.toString("utf8").slice(0, 400) : null;
        throw err;
      }
      return { buffer: buf, contentType: ct };
    } finally {
      t.cancel();
    }
  }

  return {
    flags,
    health: (timeoutMs) => request("GET", "/health", { timeoutMs: timeoutMs || flags().healthTimeoutMs }),
    filesystemHealth: () => request("GET", "/health/filesystem"),
    modelsStatus: () => request("GET", "/models/status"),
    listProfiles: () => request("GET", "/profiles"),
    getProfile: (id) => request("GET", `/profiles/${encodeURIComponent(id)}`),
    createProfile: (body) => request("POST", "/profiles", { json: body }),
    updateProfile: (id, body) => request("PUT", `/profiles/${encodeURIComponent(id)}`, { json: body }),
    listPresets: (engine) => request("GET", `/profiles/presets/${encodeURIComponent(engine)}`),
    generate: (body) => request("POST", "/generate", { json: body }),
    generateStream: (body, timeoutMs) => requestBinary("POST", "/generate/stream", { json: body, timeoutMs }),
    async generateStreamMeta(body, timeoutMs, { onAbort } = {}) {
      const f = flags();
      const t = withTimeout(timeoutMs || f.timeoutMs);
      if (typeof onAbort === "function") onAbort(() => t.abort());
      const started = Date.now();
      let firstByteMs = null;
      const rawBody = JSON.stringify(body);
      try {
        const res = await fetchImpl(joinUrl(f.baseUrl, "/generate/stream"), {
          method: "POST",
          headers: {
            Accept: "audio/wav, audio/mpeg, application/octet-stream, application/json",
            "Content-Type": "application/json",
            ...tunnelHeaders("POST", "/generate/stream", rawBody, f),
          },
          body: rawBody,
          signal: t.signal,
        });
        const ct = String(res.headers.get("content-type") || "");
        if (!res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const err = new Error(`voicebox_${res.status}`);
          err.status = res.status;
          err.body = ct.includes("json") ? buf.toString("utf8").slice(0, 400) : null;
          throw err;
        }
        if (!res.body || typeof res.body.getReader !== "function") {
          const buf = Buffer.from(await res.arrayBuffer());
          firstByteMs = Date.now() - started;
          return { buffer: buf, contentType: ct, firstByteMs, totalMs: Date.now() - started };
        }
        const reader = res.body.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength && firstByteMs == null) firstByteMs = Date.now() - started;
          chunks.push(Buffer.from(value));
        }
        const buffer = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
        return {
          buffer,
          contentType: ct,
          firstByteMs: firstByteMs ?? Date.now() - started,
          totalMs: Date.now() - started,
        };
      } finally {
        t.cancel();
      }
    },
    speak: (body) => request("POST", "/speak", { json: body }),
    generationStatus: (id) => request("GET", `/generate/${encodeURIComponent(id)}/status`),
    getHistory: (id) => request("GET", `/history/${encodeURIComponent(id)}`),
    getAudio: (id, timeoutMs) => requestBinary("GET", `/audio/${encodeURIComponent(id)}`, { timeoutMs }),
    cancelGeneration: (id) => request("POST", `/generate/${encodeURIComponent(id)}/cancel`),
    loadModel: (modelSize) =>
      request("POST", `/models/load${modelSize ? `?model_size=${encodeURIComponent(modelSize)}` : ""}`),
  };
}

module.exports = {
  createVoiceboxClient,
  joinUrl,
};
