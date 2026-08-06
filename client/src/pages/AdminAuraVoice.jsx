import { useCallback, useEffect, useState } from "react";
import { getApiOrigin } from "../services/api.js";
import { getStoredToken } from "../lib/authHeaders.js";

const panel = {
  border: "1px solid rgba(212,175,55,.35)",
  borderRadius: 14,
  background: "rgba(15,15,15,.9)",
  padding: 16,
  marginBottom: 16,
};

/**
 * IFCDC HQ — AURA Voice Intelligence Phase 1 (read-only).
 * Flag: AURA_VOICE_INTELLIGENCE_PHASE_1
 */
export default function AdminAuraVoice() {
  const [status, setStatus] = useState(null);
  const [calls, setCalls] = useState([]);
  const [stats, setStats] = useState(null);
  const [escalations, setEscalations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const authHeaders = useCallback(() => {
    const token = getStoredToken();
    return {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = getApiOrigin();
      const st = await fetch(`${base}/api/aura/voice-intelligence/status`, {
        headers: authHeaders(),
      }).then((r) => r.json());
      setStatus(st);

      if (st?.flags?.phase1Enabled) {
        const [callsRes, escRes] = await Promise.all([
          fetch(`${base}/api/aura/voice-intelligence/admin/calls?limit=80`, {
            headers: authHeaders(),
          }).then(async (r) => ({ ok: r.ok, data: await r.json() })),
          fetch(`${base}/api/aura/voice-intelligence/admin/escalations`, {
            headers: authHeaders(),
          }).then(async (r) => ({ ok: r.ok, data: await r.json() })),
        ]);
        if (callsRes.ok) {
          setCalls(Array.isArray(callsRes.data.calls) ? callsRes.data.calls : []);
          setStats(callsRes.data.stats || null);
        } else {
          setError(callsRes.data?.error || "Could not load calls");
        }
        if (escRes.ok) {
          setEscalations(Array.isArray(escRes.data.escalations) ? escRes.data.escalations : []);
        }
      } else {
        setCalls([]);
        setEscalations([]);
        setStats(null);
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const flags = status?.flags || {};

  return (
    <div style={{ maxWidth: 1100, margin: "24px auto", padding: "0 16px", color: "#f5f5f5" }}>
      <div style={{ marginBottom: 12 }}>
        <a href="/admin" style={{ color: "#d4af37" }}>
          ← Admin
        </a>
      </div>
      <h1 style={{ marginTop: 0, color: "#d4af37" }}>AURA Voice</h1>
      <p style={{ color: "#aaa", maxWidth: 760 }}>
        Voice Intelligence Phase 1 — call outcomes, intents, escalations. Disabled until{" "}
        <code>AURA_VOICE_INTELLIGENCE_PHASE_1=true</code>. Does not change Twilio Verify or SMS flags.
      </p>

      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Configuration</h2>
        <div style={{ display: "grid", gap: 8, fontSize: 14 }}>
          <div>Phase 1 enabled: {flags.phase1Enabled ? "yes" : "no"}</div>
          <div>Call logging: {flags.callLogging ? "yes" : "no"}</div>
          <div>Caller memory: {flags.callerMemory ? "yes" : "no"}</div>
          <div>Official line: {status?.numbers?.officialBusinessMasked || "—"}</div>
          <div>Owner/admin (masked): {status?.numbers?.ownerAdminMasked || "—"}</div>
          <div>Owner PIN configured: {status?.numbers?.ownerPinConfigured ? "yes" : "no"}</div>
          <div>Schema ready: {status?.schema?.ready ? "yes" : "n/a until flag on"}</div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          style={{
            marginTop: 12,
            background: "#d4af37",
            color: "#111",
            border: 0,
            borderRadius: 8,
            padding: "8px 14px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {stats ? (
        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Last 30 days</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 14 }}>
            <span>Calls: {stats.totalCalls30d}</span>
            <span>Completed: {stats.completed30d}</span>
            <span>Success rate: {stats.successRate}%</span>
            <span>Avg duration: {stats.avgDurationSec}s</span>
            <span>Escalations: {stats.escalations30d}</span>
          </div>
          {Array.isArray(stats.topIntents) && stats.topIntents.length ? (
            <div style={{ marginTop: 12, fontSize: 13, color: "#ccc" }}>
              Top intents:{" "}
              {stats.topIntents.map((i) => `${i.intent} (${i.n})`).join(" · ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div style={{ ...panel, borderColor: "rgba(255,80,80,.5)", color: "#f88" }}>{error}</div>
      ) : null}

      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Recent calls</h2>
        {loading ? <p style={{ color: "#888" }}>Loading…</p> : null}
        {!loading && !flags.phase1Enabled ? (
          <p style={{ color: "#888" }}>Enable Phase 1 on the API host to load call history.</p>
        ) : null}
        {!loading && flags.phase1Enabled && !calls.length ? (
          <p style={{ color: "#888" }}>No calls logged yet.</p>
        ) : null}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#d4af37" }}>
                <th style={{ padding: 8 }}>Started</th>
                <th style={{ padding: 8 }}>From</th>
                <th style={{ padding: 8 }}>Intent</th>
                <th style={{ padding: 8 }}>Outcome</th>
                <th style={{ padding: 8 }}>Escalation</th>
                <th style={{ padding: 8 }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                  <td style={{ padding: 8 }}>{c.started_at ? String(c.started_at).slice(0, 19) : "—"}</td>
                  <td style={{ padding: 8 }}>{c.from_e164 || "—"}</td>
                  <td style={{ padding: 8 }}>{c.primary_intent || "—"}</td>
                  <td style={{ padding: 8 }}>{c.outcome || "—"}</td>
                  <td style={{ padding: 8 }}>{c.escalation_status || "none"}</td>
                  <td style={{ padding: 8 }}>{c.duration_sec != null ? `${c.duration_sec}s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Escalations</h2>
        {!escalations.length ? (
          <p style={{ color: "#888" }}>None</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {escalations.map((e) => (
              <li key={e.id} style={{ marginBottom: 8 }}>
                <strong>{e.reason}</strong> — {e.from_e164 || "unknown"} · {e.status}
                {e.recommended_next ? ` · next: ${e.recommended_next}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
