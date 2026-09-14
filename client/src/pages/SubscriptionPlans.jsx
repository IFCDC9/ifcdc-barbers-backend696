import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authenticatedJson } from "../lib/authenticatedFetch.js";
import { catalogPublicShape } from "./subscriptionCatalogClient.js";

const page = { background: "#050505", minHeight: "100vh", color: "#f5f5f5", padding: "2rem 1rem 4rem" };
const wrap = { maxWidth: 720, margin: "0 auto" };
const gold = "#d4af37";
const card = {
  background: "#111",
  border: "1px solid rgba(212,175,55,0.45)",
  borderRadius: 14,
  padding: 20,
  marginBottom: 16,
};

export default function SubscriptionPlans() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const catalog = catalogPublicShape();

  useEffect(() => {
    authenticatedJson("/api/entitlements/me")
      .then((data) => setMe(data?.entitlements || data))
      .catch((e) => setError(e?.message || "Could not load entitlements"));
  }, []);

  return (
    <div style={page}>
      <div style={wrap}>
        <p style={{ color: gold, letterSpacing: "0.16em", fontWeight: 800, fontSize: 12 }}>IFCDC BARBERS PRO PLANS</p>
        <h1 style={{ color: gold, fontSize: "2rem", marginTop: 8 }}>Subscriptions</h1>
        <p style={{ color: "#a1a1aa", lineHeight: 1.5 }}>
          Server-verified plans only. Role is not a subscription. Shop and multi-location inherit to staff by
          permission. App access, SaaS, and the $0.99 booking fee stay separate fields.
        </p>
        {error ? <p style={{ color: "#f87171" }}>{error}</p> : null}
        <div style={card}>
          <div style={{ color: gold, fontWeight: 800 }}>Your entitlement</div>
          <p style={{ margin: "8px 0 0" }}>
            Plan: <strong>{me?.planKey || "none"}</strong> · Status: {me?.subscriptionStatus || "none"} · Mode:{" "}
            {me?.mode || "observe_sandbox"}
          </p>
        </div>
        {catalog.apple.products.map((p) => (
          <div key={p.productId} style={card}>
            <div style={{ color: gold, fontWeight: 800, textTransform: "capitalize" }}>{p.planKey}</div>
            <div style={{ fontSize: 28, fontWeight: 700, margin: "6px 0" }}>${p.listPriceUsd.toFixed(2)}/mo</div>
            <p style={{ color: "#a1a1aa", margin: 0 }}>
              {p.productId} · intro: free first month · group: {catalog.apple.subscriptionGroup}
            </p>
            <p style={{ color: "#71717a", fontSize: 13 }}>
              Promo/win-back placeholder ${catalog.apple.promoPlaceholders[p.planKey].priceUsd} / 3 mo — confirm App
              Store Connect promotional offer IDs with Tessa
            </p>
          </div>
        ))}
        <div style={card}>
          <div style={{ color: gold, fontWeight: 800 }}>Android app access</div>
          <p>
            One-time ${catalog.google.access.listPriceUsd.toFixed(2)} · product{" "}
            <code>{catalog.google.access.productId}</code> · confirm with Tessa before production
          </p>
        </div>
        <p style={{ color: "#71717a", fontSize: 13 }}>
          Purchases complete in the iOS/Android app. This page observes <code>GET /api/entitlements/me</code>.
        </p>
        <Link to="/profile" style={{ color: gold, fontWeight: 800 }}>
          ← Profile
        </Link>
      </div>
    </div>
  );
}
