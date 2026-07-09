import { fetchAppJson } from "./appSession";
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
  const data = await fetchAppJson<{
    points?: number;
    lifetimeEarned?: number;
    transactions?: LoyaltyTransaction[];
    rewards?: LoyaltyReward[];
  }>("/api/loyalty/me");

  return {
    points: Number(data.points) || 0,
    lifetimeEarned: Number(data.lifetimeEarned) || 0,
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    rewards: Array.isArray(data.rewards) ? data.rewards : [],
  };
}

export async function redeemReward(rewardId: string): Promise<{ message: string; points: number }> {
  const data = await fetchAppJson<{ message?: string; account?: { points_balance?: number } }>(
    "/api/loyalty/redeem",
    { method: "POST", body: JSON.stringify({ rewardId }) },
  );
  return {
    message: String(data.message || "Redeemed"),
    points: Number(data.account?.points_balance) || 0,
  };
}

export async function fetchBarberManagedRewards(barberId: string | number): Promise<LoyaltyReward[]> {
  const q = encodeURIComponent(String(barberId));
  const data = await fetchAppJson<{ rewards?: LoyaltyReward[] }>(`/api/barber/loyalty/rewards?barberId=${q}`);
  return Array.isArray(data.rewards) ? data.rewards : [];
}

export async function saveBarberReward(
  barberId: string | number,
  body: { title: string; description?: string; points_cost: number; is_active?: boolean },
  rewardId?: string,
): Promise<LoyaltyReward> {
  const q = encodeURIComponent(String(barberId));
  const path = rewardId
    ? `/api/barber/loyalty/rewards/${encodeURIComponent(rewardId)}?barberId=${q}`
    : `/api/barber/loyalty/rewards?barberId=${q}`;
  const data = await fetchAppJson<{ reward: LoyaltyReward }>(path, {
    method: rewardId ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  return data.reward;
}
