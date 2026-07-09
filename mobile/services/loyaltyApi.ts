import { apiFetch } from "./api";

export type LoyaltyReward = {
  id: string;
  barber_id?: string | null;
  title: string;
  description?: string | null;
  points_cost: number;
  is_active?: boolean;
};

export type LoyaltyTransaction = {
  id: string;
  booking_id?: string | null;
  delta: number;
  reason: string;
  created_at: string;
};

export async function fetchMyLoyalty(): Promise<{
  points: number;
  lifetimeEarned: number;
  transactions: LoyaltyTransaction[];
  rewards: LoyaltyReward[];
}> {
  const res = await apiFetch("/api/loyalty/me");
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.message || "Could not load rewards");
  return {
    points: Number(data.points) || 0,
    lifetimeEarned: Number(data.lifetimeEarned) || 0,
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    rewards: Array.isArray(data.rewards) ? data.rewards : [],
  };
}

export async function redeemReward(rewardId: string): Promise<{ message: string; points: number }> {
  const res = await apiFetch("/api/loyalty/redeem", {
    method: "POST",
    body: JSON.stringify({ rewardId }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.message || "Redemption failed");
  return {
    message: String(data.message || "Redeemed"),
    points: Number(data.account?.points_balance) || 0,
  };
}

export async function fetchBarberManagedRewards(barberId: string | number): Promise<LoyaltyReward[]> {
  const q = encodeURIComponent(String(barberId));
  const res = await apiFetch(`/api/barber/loyalty/rewards?barberId=${q}`);
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.message || "Could not load rewards");
  return Array.isArray(data.rewards) ? data.rewards : [];
}

export async function saveBarberReward(
  barberId: string | number,
  body: { title: string; description?: string; points_cost: number; is_active?: boolean },
  rewardId?: string,
): Promise<LoyaltyReward> {
  const q = encodeURIComponent(String(barberId));
  const url = rewardId
    ? `/api/barber/loyalty/rewards/${encodeURIComponent(rewardId)}?barberId=${q}`
    : `/api/barber/loyalty/rewards?barberId=${q}`;
  const res = await apiFetch(url, {
    method: rewardId ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.message || "Save failed");
  return data.reward;
}
