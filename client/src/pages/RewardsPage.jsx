import { Link, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { fetchMyLoyalty } from "../services/loyaltyApi.js";
import { hasWebSession } from "../lib/appSession.js";

const EMPTY = {
  points: 0,
  completedHaircuts: 0,
  progressPercent: 0,
  pointsToNextReward: 0,
  nextReward: null,
  availableRewards: [],
  upcomingRewards: [],
  reservedRewards: [],
  redeemedRewards: [],
  transactions: [],
};

function RewardCard({ reward, locked = false }) {
  return (
    <li className="ifcdc-book-wizard__summary" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span>{locked ? "🔒" : "✓"}</span>
        <div style={{ flex: 1 }}>
          <strong>{reward.title}</strong>
          {reward.description ? <div style={{ opacity: 0.78, marginTop: 4 }}>{reward.description}</div> : null}
          {!locked ? (
            <div style={{ color: "#d4af37", fontSize: 12, marginTop: 6 }}>
              Choose during booking checkout
            </div>
          ) : null}
        </div>
        <strong style={{ color: "#FFD700" }}>{reward.points_cost} pts</strong>
      </div>
    </li>
  );
}

export default function RewardsPage() {
  const navigate = useNavigate();
  const signedIn = hasWebSession();
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!hasWebSession()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData({ ...EMPTY, ...(await fetchMyLoyalty()) });
    } catch (e) {
      setError(e?.message || "Could not load rewards");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!signedIn) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">⭐ Loyalty Rewards</h1>
        <p className="ifcdc-page-lead">Sign in to earn and use rewards.</p>
        <Link to="/login" className="ifcdc-book-wizard__cta">Sign in</Link>
      </div>
    );
  }

  return (
    <div className="ifcdc-profile">
      <button type="button" className="ifcdc-book-wizard__back" onClick={() => navigate("/profile")}>
        ← Profile
      </button>
      <h1 className="ifcdc-page-title">⭐ Loyalty Rewards</h1>
      <p className="ifcdc-page-lead">Earn points only after paid appointments are completed.</p>
      {loading ? <p className="ifcdc-page-hint">Loading…</p> : null}
      {error ? (
        <div className="ifcdc-error-msg">
          <p>{error}</p>
          <button type="button" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {!loading && !error ? (
        <>
          <section className="ifcdc-book-wizard__summary" style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ opacity: 0.75, fontWeight: 700 }}>Current Points</div>
            <div style={{ fontSize: 46, fontWeight: 900, color: "#FFD700" }}>{data.points}</div>
            <div style={{ fontWeight: 800 }}>Completed Haircuts: {data.completedHaircuts}</div>
            <div style={{ height: 10, borderRadius: 99, background: "rgba(255,255,255,.1)", overflow: "hidden", margin: "14px 0" }}>
              <div style={{ width: `${data.progressPercent}%`, height: "100%", background: "#d4af37" }} />
            </div>
            {data.nextReward ? (
              <>
                <div style={{ opacity: 0.7, fontSize: 12 }}>Next Reward</div>
                <strong style={{ fontSize: 18 }}>{data.nextReward.title}</strong>
                <div style={{ color: "#FFD700", marginTop: 4 }}>
                  Only {data.pointsToNextReward} more points to go!
                </div>
              </>
            ) : (
              <div style={{ color: "#FFD700" }}>You reached every active reward tier.</div>
            )}
          </section>

          <h2 className="ifcdc-book-wizard__heading">Available Rewards</h2>
          {!data.availableRewards.length ? <p className="ifcdc-page-hint">Keep booking — your next reward is getting closer.</p> : null}
          <ul className="ifcdc-book-wizard__list">
            {data.availableRewards.map((reward) => <RewardCard key={reward.id} reward={reward} />)}
          </ul>

          <h2 className="ifcdc-book-wizard__heading">Upcoming Rewards</h2>
          <ul className="ifcdc-book-wizard__list">
            {data.upcomingRewards.map((reward) => <RewardCard key={reward.id} reward={reward} locked />)}
          </ul>

          <h2 className="ifcdc-book-wizard__heading">Reserved Rewards</h2>
          {!data.reservedRewards.length ? <p className="ifcdc-page-hint">No rewards currently reserved.</p> : null}
          {data.reservedRewards.map((item) => (
            <div key={item.id} className="ifcdc-book-wizard__summary" style={{ marginBottom: 8 }}>
              <strong>{item.title}</strong> · {item.points_spent} points · Reserved
            </div>
          ))}

          <h2 className="ifcdc-book-wizard__heading">Redeemed Rewards</h2>
          {!data.redeemedRewards.length ? <p className="ifcdc-page-hint">Completed redemptions will appear here.</p> : null}
          {data.redeemedRewards.map((item) => (
            <div key={item.id} className="ifcdc-book-wizard__summary" style={{ marginBottom: 8 }}>
              <strong>{item.title}</strong> · {item.points_spent} points
            </div>
          ))}

          <h2 className="ifcdc-book-wizard__heading">Reward History</h2>
          {data.transactions.slice(0, 30).map((item) => (
            <div key={item.id} className="ifcdc-book-wizard__summary" style={{ display: "flex", marginBottom: 6 }}>
              <span style={{ flex: 1 }}>{item.reward_title || String(item.reason || "").replaceAll("_", " ")}</span>
              <strong style={{ color: item.delta < 0 ? "#FFD700" : "#70d69a" }}>
                {item.delta > 0 ? "+" : ""}{item.delta}
              </strong>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
