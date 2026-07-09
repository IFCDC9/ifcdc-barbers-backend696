import { getApiOrigin } from "./api.js";
import { getStoredToken } from "../lib/authHeaders.js";

function authHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" };
}

export async function fetchMyLoyalty() {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/loyalty/me`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function redeemReward(rewardId) {
  const origin = getApiOrigin();
  const res = await fetch(`${origin}/api/loyalty/redeem`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ rewardId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

export async function fetchBarberManagedRewards(barberId) {
  const origin = getApiOrigin();
  const q = encodeURIComponent(String(barberId));
  const res = await fetch(`${origin}/api/barber/loyalty/rewards?barberId=${q}`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.rewards || [];
}

export async function saveBarberReward(barberId, body, rewardId) {
  const origin = getApiOrigin();
  const q = encodeURIComponent(String(barberId));
  const url = rewardId
    ? `${origin}/api/barber/loyalty/rewards/${encodeURIComponent(rewardId)}?barberId=${q}`
    : `${origin}/api/barber/loyalty/rewards?barberId=${q}`;
  const res = await fetch(url, {
    method: rewardId ? "PUT" : "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.reward;
}
