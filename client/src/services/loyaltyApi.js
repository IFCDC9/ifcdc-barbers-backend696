import { authenticatedJson } from "../lib/appSession.js";

function authHeaders() {
  return { Accept: "application/json" };
}

export async function fetchMyLoyalty() {
  return authenticatedJson("/api/loyalty/me", { headers: authHeaders() });
}

export async function redeemReward(rewardId) {
  return authenticatedJson("/api/loyalty/redeem", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ rewardId }),
  });
}

export async function fetchBarberManagedRewards(barberId) {
  const q = encodeURIComponent(String(barberId));
  const data = await authenticatedJson(`/api/barber/loyalty/rewards?barberId=${q}`, { headers: authHeaders() });
  return data.rewards || [];
}

export async function saveBarberReward(barberId, body, rewardId) {
  const q = encodeURIComponent(String(barberId));
  const path = rewardId
    ? `/api/barber/loyalty/rewards/${encodeURIComponent(rewardId)}?barberId=${q}`
    : `/api/barber/loyalty/rewards?barberId=${q}`;
  const data = await authenticatedJson(path, {
    method: rewardId ? "PUT" : "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.reward;
}
