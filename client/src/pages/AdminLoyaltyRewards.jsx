import { useCallback, useEffect, useState } from "react";
import {
  adjustCustomerPoints,
  deleteAdminReward,
  fetchAdminRewards,
  fetchLoyaltyReport,
  saveAdminReward,
  setAdminRewardStatus,
} from "../services/loyaltyApi.js";

const EMPTY_DRAFT = {
  title: "",
  description: "",
  points_cost: "",
  reward_type: "custom",
  reward_value: "0",
  promo_code: "",
  eligible_services: "",
  eligible_barbers: "",
  expires_at: "",
  quantity_limit: "",
  is_active: true,
  metadata: {},
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

function commaList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export default function AdminLoyaltyRewards() {
  const [rewards, setRewards] = useState([]);
  const [report, setReport] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [adjustment, setAdjustment] = useState({ customer: "", delta: "", reason: "", note: "" });

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [rewardRows, reportData] = await Promise.all([fetchAdminRewards(), fetchLoyaltyReport()]);
      setRewards(rewardRows);
      setReport(reportData);
    } catch (error) {
      setMessage(error?.message || "Could not load loyalty administration.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await saveAdminReward({
        ...draft,
        points_cost: Number(draft.points_cost),
        reward_value: Number(draft.reward_value || 0),
        eligible_services: commaList(draft.eligible_services),
        eligible_barbers: commaList(draft.eligible_barbers),
        quantity_limit: draft.quantity_limit ? Number(draft.quantity_limit) : null,
        expires_at: draft.expires_at || null,
        metadata: {
          ...(draft.metadata || {}),
          promoCode: draft.promo_code.trim().toUpperCase() || undefined,
        },
      }, editingId || undefined);
      setDraft(EMPTY_DRAFT);
      setEditingId("");
      setMessage("Reward saved.");
      await load();
    } catch (error) {
      setMessage(error?.message || "Could not save reward.");
    } finally {
      setBusy(false);
    }
  };

  const edit = (reward) => {
    setEditingId(reward.id);
    setDraft({
      title: reward.title || "",
      description: reward.description || "",
      points_cost: String(reward.points_cost || ""),
      reward_type: reward.reward_type || "custom",
      reward_value: String(reward.reward_value || 0),
      promo_code: reward.metadata?.promoCode || reward.metadata?.promo_code || "",
      eligible_services: (reward.eligible_services || []).join(", "),
      eligible_barbers: (reward.eligible_barbers || []).join(", "),
      expires_at: reward.expires_at ? String(reward.expires_at).slice(0, 10) : "",
      quantity_limit: reward.quantity_limit == null ? "" : String(reward.quantity_limit),
      is_active: reward.is_active !== false,
      metadata: reward.metadata || {},
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitAdjustment = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await adjustCustomerPoints({
        ...adjustment,
        userId: adjustment.customer.includes("@") ? undefined : adjustment.customer,
        email: adjustment.customer.includes("@") ? adjustment.customer : undefined,
        delta: Number(adjustment.delta),
      });
      setAdjustment({ customer: "", delta: "", reason: "", note: "" });
      setMessage("Points adjustment saved and audit logged.");
      await load();
    } catch (error) {
      setMessage(error?.message || "Adjustment failed.");
    } finally {
      setBusy(false);
    }
  };

  const summary = report?.summary || {};

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 20, color: "#fff" }}>
      <h1 style={{ color: "#d4af37" }}>Loyalty Rewards Administration</h1>
      <p style={{ opacity: 0.75 }}>Configure tiers, monitor liability, and audit every points change.</p>
      {message ? <p style={{ color: "#FFD700" }}>{message}</p> : null}

      <form onSubmit={save} style={panel}>
        <h2>{editingId ? "Edit Reward Tier" : "Create Reward Tier"}</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
          <input required style={input} placeholder="Reward name" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <input required type="number" min="1" style={input} placeholder="Required points" value={draft.points_cost} onChange={(e) => setDraft({ ...draft, points_cost: e.target.value })} />
          <select style={input} value={draft.reward_type} onChange={(e) => setDraft({ ...draft, reward_type: e.target.value })}>
            <option value="custom">Custom / Gift</option>
            <option value="discount_fixed">Fixed-dollar discount</option>
            <option value="discount_percent">Percentage discount</option>
            <option value="free_service">Free service or upgrade</option>
            <option value="free_standard_haircut">Free standard haircut</option>
            <option value="vip_package">VIP package</option>
            <option value="product">Free product</option>
            <option value="coupon">Coupon code</option>
            <option value="membership_perk">VIP membership perk</option>
          </select>
          <input type="number" min="0" step="0.01" style={input} placeholder="Reward value" value={draft.reward_value} onChange={(e) => setDraft({ ...draft, reward_value: e.target.value })} />
          <input style={input} placeholder="Promo code (optional)" value={draft.promo_code} onChange={(e) => setDraft({ ...draft, promo_code: e.target.value.toUpperCase() })} />
          <input style={input} placeholder="Eligible services, comma separated" value={draft.eligible_services} onChange={(e) => setDraft({ ...draft, eligible_services: e.target.value })} />
          <input style={input} placeholder="Eligible barber IDs/names, comma separated" value={draft.eligible_barbers} onChange={(e) => setDraft({ ...draft, eligible_barbers: e.target.value })} />
          <label>
            <small>Expiration date (optional)</small>
            <input type="date" style={input} value={draft.expires_at} onChange={(e) => setDraft({ ...draft, expires_at: e.target.value })} />
          </label>
          <input type="number" min="1" style={input} placeholder="Quantity limit (optional)" value={draft.quantity_limit} onChange={(e) => setDraft({ ...draft, quantity_limit: e.target.value })} />
        </div>
        <textarea style={{ ...input, marginTop: 10, minHeight: 80 }} placeholder="Reward description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <label style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />
          Active
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="ifcdc-book-wizard__cta" disabled={busy} type="submit">{editingId ? "Update Tier" : "Create Tier"}</button>
          {editingId ? <button type="button" className="ifcdc-book-wizard__back" onClick={() => { setDraft(EMPTY_DRAFT); setEditingId(""); }}>Cancel edit</button> : null}
        </div>
      </form>

      <section style={panel}>
        <h2>Reward Tiers</h2>
        <div style={{ display: "grid", gap: 10 }}>
          {rewards.map((reward) => (
            <article key={reward.id} style={{ border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <strong style={{ flex: 1 }}>{reward.points_cost} pts · {reward.title}</strong>
                <span>{reward.is_active ? "Active" : "Inactive"}</span>
                <button type="button" onClick={() => edit(reward)}>Edit</button>
                <button type="button" onClick={async () => { await setAdminRewardStatus(reward.id, !reward.is_active); await load(); }}>
                  {reward.is_active ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={async () => {
                  if (!window.confirm(`Delete ${reward.title}?`)) return;
                  await deleteAdminReward(reward.id);
                  await load();
                }}>Delete</button>
              </div>
              <small style={{ opacity: 0.7 }}>
                {reward.reward_type} · value ${Number(reward.reward_value || 0).toFixed(2)}
                {reward.metadata?.promoCode ? ` · code ${reward.metadata.promoCode}` : ""}
                {reward.quantity_limit ? ` · ${reward.quantity_redeemed}/${reward.quantity_limit} redeemed` : ""}
              </small>
            </article>
          ))}
        </div>
      </section>

      <section style={panel}>
        <h2>Reporting</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
          {[
            ["Points Awarded", summary.points_awarded || 0],
            ["Points Redeemed", summary.points_redeemed || 0],
            ["Reward Redemptions", summary.reward_redemptions || 0],
            ["Liability Points", summary.reward_liability_points || 0],
            ["Liability Value", `$${Number(summary.reward_liability_value || 0).toFixed(2)}`],
            ["Expired Rewards", summary.expired_rewards || 0],
          ].map(([label, value]) => (
            <div key={label} style={{ ...panel, margin: 0, textAlign: "center" }}>
              <small style={{ opacity: 0.7 }}>{label}</small>
              <div style={{ color: "#FFD700", fontWeight: 900, fontSize: 24 }}>{value}</div>
            </div>
          ))}
        </div>
        <h3>Most Redeemed Rewards</h3>
        {(report?.mostRedeemedRewards || []).map((row) => <p key={row.id}>{row.title} — {row.redemptions} redemptions</p>)}
        <h3>Most Loyal Customers</h3>
        {(report?.mostLoyalCustomers || []).map((row) => <p key={row.user_id}>{row.name || row.email} — {row.completed_haircuts} completed haircuts · {row.points_balance} points</p>)}
        <h3>Top Spending Customers</h3>
        {(report?.topSpendingCustomers || []).map((row) => <p key={row.user_id}>{row.name || row.email} — ${Number(row.total_spent || 0).toFixed(2)}</p>)}
      </section>

      <form onSubmit={submitAdjustment} style={panel}>
        <h2>Manual Points Adjustment</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
          <input required style={input} placeholder="Customer email or user UUID" value={adjustment.customer} onChange={(e) => setAdjustment({ ...adjustment, customer: e.target.value })} />
          <input required type="number" style={input} placeholder="Points (+ or -)" value={adjustment.delta} onChange={(e) => setAdjustment({ ...adjustment, delta: e.target.value })} />
          <input required style={input} placeholder="Reason" value={adjustment.reason} onChange={(e) => setAdjustment({ ...adjustment, reason: e.target.value })} />
          <input style={input} placeholder="Audit note" value={adjustment.note} onChange={(e) => setAdjustment({ ...adjustment, note: e.target.value })} />
        </div>
        <button className="ifcdc-book-wizard__cta" disabled={busy} type="submit" style={{ marginTop: 12 }}>Apply Adjustment</button>
      </form>

      <section style={panel}>
        <h2>Recent Audit Log</h2>
        {(report?.auditLogs || []).map((row) => (
          <p key={row.id} style={{ borderBottom: "1px solid rgba(255,255,255,.08)", paddingBottom: 8 }}>
            <strong>{row.action}</strong> · {row.actor_label} · {new Date(row.created_at).toLocaleString()}
          </p>
        ))}
      </section>
    </main>
  );
}
