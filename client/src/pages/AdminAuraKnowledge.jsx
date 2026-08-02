import { useCallback, useEffect, useState } from "react";
import {
  askAuraKnowledge,
  createAuraKnowledgeArticle,
  fetchAuraKnowledgeArticles,
  fetchAuraKnowledgeStatus,
  migrateAuraKnowledge,
  seedAuraKnowledgeDrafts,
  updateAuraKnowledgeArticle,
} from "../services/auraKnowledgeApi.js";

const EMPTY_DRAFT = {
  title: "",
  body: "",
  category: "faq",
  slug: "",
  sourceType: "curated",
  liveQueryKey: "",
  status: "draft",
  confidence: "approved",
  changeNote: "",
};

const panel = {
  border: "1px solid rgba(212,175,55,.35)",
  borderRadius: 14,
  background: "rgba(15,15,15,.9)",
  padding: 16,
  marginBottom: 16,
};

const input = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(255,255,255,.16)",
  borderRadius: 9,
  background: "#171717",
  color: "#fff",
  padding: "10px 12px",
};

const CATEGORIES = [
  "services",
  "pricing",
  "duration",
  "barbers",
  "hours",
  "location",
  "policies",
  "rewards",
  "payments",
  "languages",
  "support",
  "faq",
];

export default function AdminAuraKnowledge() {
  const [articles, setArticles] = useState([]);
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [filterStatus, setFilterStatus] = useState("");
  const [previewQ, setPreviewQ] = useState("What is your cancellation policy?");
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [st, list] = await Promise.all([
        fetchAuraKnowledgeStatus().catch((e) => ({ ok: false, error: e?.message })),
        fetchAuraKnowledgeArticles(filterStatus ? { status: filterStatus } : {}),
      ]);
      setStatus(st);
      setArticles(list?.articles || []);
      if (list?.categories?.length) {
        /* categories come from API; keep local fallback */
      }
    } catch (error) {
      setMessage(
        error?.message ||
          "Could not load AURA knowledge. Ensure AURA_PHASE3_ENABLED and AURA_PHASE3_KNOWLEDGE are on locally.",
      );
    } finally {
      setBusy(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const payload = {
        title: draft.title,
        body: draft.body,
        category: draft.category,
        slug: draft.slug || undefined,
        sourceType: draft.sourceType,
        liveQueryKey: draft.liveQueryKey || null,
        status: draft.status,
        confidence: draft.confidence,
        changeNote: draft.changeNote || undefined,
      };
      if (editingId) {
        await updateAuraKnowledgeArticle(editingId, payload);
        setMessage("Article updated (new version saved).");
      } else {
        await createAuraKnowledgeArticle(payload);
        setMessage("Draft article created.");
      }
      setDraft(EMPTY_DRAFT);
      setEditingId("");
      await load();
    } catch (error) {
      setMessage(error?.message || "Could not save article.");
    } finally {
      setBusy(false);
    }
  };

  const edit = (row) => {
    setEditingId(row.id);
    setDraft({
      title: row.title || "",
      body: row.body || "",
      category: row.category || "faq",
      slug: row.slug || "",
      sourceType: row.source_type || "curated",
      liveQueryKey: row.live_query_key || "",
      status: row.status || "draft",
      confidence: row.confidence || "approved",
      changeNote: "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const setStatusQuick = async (row, nextStatus) => {
    setBusy(true);
    setMessage("");
    try {
      await updateAuraKnowledgeArticle(row.id, {
        status: nextStatus,
        changeNote: `status → ${nextStatus}`,
      });
      setMessage(`Article marked ${nextStatus}.`);
      await load();
    } catch (error) {
      setMessage(error?.message || "Status update failed.");
    } finally {
      setBusy(false);
    }
  };

  const runSeed = async () => {
    setBusy(true);
    try {
      await migrateAuraKnowledge().catch(() => null);
      const out = await seedAuraKnowledgeDrafts();
      setMessage(`Seeded ${out?.created ?? 0} draft starter articles.`);
      await load();
    } catch (error) {
      setMessage(error?.message || "Seed failed.");
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setPreview(null);
    try {
      const out = await askAuraKnowledge(previewQ);
      setPreview(out);
    } catch (error) {
      setPreview({ ok: false, error: error?.message || "ask failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 980, margin: "24px auto", padding: "0 16px", color: "#f5f5f5" }}>
      <h1 style={{ color: "#d4af37", marginBottom: 8 }}>AURA Knowledge (Phase 3A)</h1>
      <p style={{ opacity: 0.75, marginTop: 0 }}>
        Approve public business facts AURA may speak. Draft and disabled articles never answer
        customers. Live catalog rows are preferred for prices, hours, and location.
      </p>

      <div style={panel}>
        <strong>Flags</strong>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.85 }}>
          {JSON.stringify(status?.flags || status || {}, null, 2)}
        </pre>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" disabled={busy} onClick={() => void runSeed()}>
            Seed starter drafts
          </button>
          <a href="/admin" style={{ color: "#d4af37", alignSelf: "center" }}>
            ← Admin
          </a>
        </div>
      </div>

      {message ? (
        <p style={{ color: "#d4af37", marginBottom: 12 }}>{message}</p>
      ) : null}

      <form style={panel} onSubmit={save}>
        <h2 style={{ marginTop: 0, color: "#d4af37" }}>
          {editingId ? "Edit article" : "New article"}
        </h2>
        <div style={{ display: "grid", gap: 10 }}>
          <input
            style={input}
            placeholder="Title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            required
          />
          <textarea
            style={{ ...input, minHeight: 120 }}
            placeholder="Public body (no internal notes)"
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            required
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <select
              style={input}
              value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              style={input}
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
            >
              <option value="draft">draft</option>
              <option value="approved">approved</option>
              <option value="disabled">disabled</option>
            </select>
            <select
              style={input}
              value={draft.sourceType}
              onChange={(e) => setDraft((d) => ({ ...d, sourceType: e.target.value }))}
            >
              <option value="curated">curated</option>
              <option value="live_db">live_db</option>
              <option value="hybrid">hybrid</option>
            </select>
            <input
              style={input}
              placeholder="live query key (optional)"
              value={draft.liveQueryKey}
              onChange={(e) => setDraft((d) => ({ ...d, liveQueryKey: e.target.value }))}
            />
            <input
              style={input}
              placeholder="slug (optional)"
              value={draft.slug}
              onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
            />
            <input
              style={input}
              placeholder="change note"
              value={draft.changeNote}
              onChange={(e) => setDraft((d) => ({ ...d, changeNote: e.target.value }))}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={busy}>
              {editingId ? "Save version" : "Create"}
            </button>
            {editingId ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingId("");
                  setDraft(EMPTY_DRAFT);
                }}
              >
                Cancel edit
              </button>
            ) : null}
          </div>
        </div>
      </form>

      <div style={panel}>
        <h2 style={{ marginTop: 0, color: "#d4af37" }}>Preview ask (read-only)</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ ...input, flex: 1 }}
            value={previewQ}
            onChange={(e) => setPreviewQ(e.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => void runPreview()}>
            Ask AURA
          </button>
        </div>
        {preview ? (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 12 }}>
            {JSON.stringify(preview, null, 2)}
          </pre>
        ) : null}
      </div>

      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, color: "#d4af37" }}>Articles</h2>
          <select
            style={{ ...input, width: 160 }}
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">all</option>
            <option value="draft">draft</option>
            <option value="approved">approved</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
        {!articles.length ? (
          <p style={{ opacity: 0.7 }}>No articles yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
            {articles.map((row) => (
              <li
                key={row.id}
                style={{
                  borderTop: "1px solid rgba(255,255,255,.08)",
                  padding: "12px 0",
                }}
              >
                <div style={{ fontWeight: 700 }}>
                  {row.title}{" "}
                  <span style={{ opacity: 0.65, fontWeight: 400 }}>
                    v{row.version} · {row.status} · {row.category} · {row.source_type}
                  </span>
                </div>
                <p style={{ opacity: 0.8, margin: "6px 0 10px" }}>
                  {String(row.body || "").slice(0, 180)}
                  {String(row.body || "").length > 180 ? "…" : ""}
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" disabled={busy} onClick={() => edit(row)}>
                    Edit
                  </button>
                  {row.status !== "approved" ? (
                    <button type="button" disabled={busy} onClick={() => void setStatusQuick(row, "approved")}>
                      Approve
                    </button>
                  ) : null}
                  {row.status !== "disabled" ? (
                    <button type="button" disabled={busy} onClick={() => void setStatusQuick(row, "disabled")}>
                      Disable
                    </button>
                  ) : null}
                  {row.status === "disabled" ? (
                    <button type="button" disabled={busy} onClick={() => void setStatusQuick(row, "draft")}>
                      Reopen draft
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
