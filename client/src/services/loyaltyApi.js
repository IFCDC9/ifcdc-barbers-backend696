import { authenticatedFetch } from "../lib/authenticatedFetch.js";

function authHeaders() {
  return { Accept: "application/json" };
}

export async function fetchMyLoyalty() {
  const res = await authenticatedFetch("/api/loyalty/me", { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function redeemReward(rewardId) {
  const res = await authenticatedFetch("/api/loyalty/redeem", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ rewardId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchBarberManagedRewards(barberId) {
  const q = encodeURIComponent(String(barberId));
  const res = await authenticatedFetch(`/api/barber/loyalty/rewards?barberId=${q}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.rewards || [];
}

export async function saveBarberReward(barberId, body, rewardId) {
  const q = encodeURIComponent(String(barberId));
  const path = rewardId
    ? `/api/barber/loyalty/rewards/${encodeURIComponent(rewardId)}?barberId=${q}`
    : `/api/barber/loyalty/rewards?barberId=${q}`;
  const res = await authenticatedFetch(path, {
    method: rewardId ? "PUT" : "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.reward;
}
