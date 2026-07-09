import { Link, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { fetchMyLoyalty, redeemReward } from "../services/loyaltyApi.js";
import { hasWebSession } from "../lib/appSession.js";

export default function RewardsPage() {
  const navigate = useNavigate();
  const signedIn = hasWebSession();
  const [points, setPoints] = useState(0);
  const [rewards, setRewards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!hasWebSession()) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMyLoyalty();
      setPoints(Number(data.points) || 0);
      setRewards(Array.isArray(data.rewards) ? data.rewards : []);
    } catch (e) {
      const msg = String(e?.message || "Could not load rewards");
      setError(
        msg.includes("Network error") || msg.includes("timed out")
          ? "Could not reach the server. Wait a moment and tap Try again."
          : msg,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRedeem = async (reward) => {
    setMessage("");
    try {
      const result = await redeemReward(reward.id);
      setMessage(result.message || "Redeemed!");
      setPoints(Number(result.account?.points_balance ?? result.points) || 0);
      await load();
    } catch (e) {
      setMessage(e?.message || "Redemption failed");
    }
  };

  if (!signedIn) {
    return (
      <div className="ifcdc-profile">
        <h1 className="ifcdc-page-title">Rewards</h1>
        <p className="ifcdc-page-lead">Sign in to earn and redeem points.</p>
        <Link to="/login" className="ifcdc-book-wizard__cta">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="ifcdc-profile">
      <button type="button" className="ifcdc-book-wizard__back" onClick={() => navigate("/profile")}>
        ← Profile
      </button>
      <h1 className="ifcdc-page-title">Rewards</h1>
      <p className="ifcdc-page-lead">Earn 1 point per $1 after each completed booking.</p>
      {loading ? <p className="ifcdc-page-hint">Loading…</p> : null}
      {error ? (
        <div className="ifcdc-error-msg">
          <p>{error}</p>
          <button type="button" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {message ? <p className="ifcdc-page-hint">{message}</p> : null}
      {!loading && !error ? (
        <>
          <div className="ifcdc-book-wizard__summary" style={{ textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 13, opacity: 0.8 }}>Your balance</div>
            <div style={{ fontSize: 40, fontWeight: 900, color: "#FFD700" }}>{points}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>points</div>
          </div>
          <h2 className="ifcdc-book-wizard__heading">Redeem</h2>
          {!rewards.length ? (
            <p className="ifcdc-page-hint">No rewards available yet. Check back soon.</p>
          ) : null}
          <ul className="ifcdc-book-wizard__list">
            {rewards.map((reward) => {
              const cost = Number(reward.points_cost) || 0;
              const canRedeem = points >= cost;
              return (
                <li key={reward.id} className="ifcdc-book-wizard__summary">
                  <strong>{reward.title}</strong>
                  {reward.description ? (
                    <>
                      <br />
                      {reward.description}
                    </>
                  ) : null}
                  <br />
                  {cost} points
                  <br />
                  <button
                    type="button"
                    className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost"
                    style={{ marginTop: 8 }}
                    disabled={!canRedeem}
                    onClick={() => void onRedeem(reward)}
                  >
                    {canRedeem ? "Redeem" : `Need ${cost - points} more`}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
