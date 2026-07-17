import { authenticatedJson } from "../lib/appSession.js";

function authHeaders() {
  return { Accept: "application/json" };
}

export async function fetchMyLoyalty(barberId) {
  const suffix = barberId != null && String(barberId).trim()
    ? `?barberId=${encodeURIComponent(String(barberId))}`
    : "";
  return authenticatedJson(`/api/loyalty/me${suffix}`, { headers: authHeaders() });
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

export async function fetchAdminRewards() {
  const data = await authenticatedJson("/api/admin/loyalty/rewards", { headers: authHeaders() });
  return data.rewards || [];
}

export async function saveAdminReward(body, rewardId) {
  return authenticatedJson(
    rewardId
      ? `/api/admin/loyalty/rewards/${encodeURIComponent(rewardId)}`
      : "/api/admin/loyalty/rewards",
    {
      method: rewardId ? "PUT" : "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function setAdminRewardStatus(rewardId, isActive) {
  return authenticatedJson(`/api/admin/loyalty/rewards/${encodeURIComponent(rewardId)}/status`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ is_active: isActive }),
  });
}

export async function deleteAdminReward(rewardId) {
  return authenticatedJson(`/api/admin/loyalty/rewards/${encodeURIComponent(rewardId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function fetchLoyaltyReport() {
  return authenticatedJson("/api/admin/loyalty/report?limit=30", { headers: authHeaders() });
}

export async function adjustCustomerPoints(body) {
  return authenticatedJson("/api/admin/loyalty/adjustments", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
