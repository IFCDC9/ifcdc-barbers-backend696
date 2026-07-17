import { fetchAppJson } from "./appSession";
import { apiFetch } from "./api";

export type LoyaltyReward = {
  id: string;
  barber_id?: string | null;
  title: string;
  description?: string | null;
  points_cost: number;
  reward_type?: string;
  reward_value?: number;
  eligible_services?: string[];
  eligible_barbers?: string[];
  expires_at?: string | null;
  quantity_limit?: number | null;
  quantity_redeemed?: number;
  is_active?: boolean;
};

export type LoyaltyTransaction = {
  id: string;
  booking_id?: string | null;
  delta: number;
  reason: string;
  transaction_type?: string;
  reward_title?: string | null;
  created_at: string;
};

export type RewardHistoryItem = {
  id: string;
  booking_id?: string | null;
  points_spent: number;
  discount_amount?: number;
  status: "reserved" | "redeemed" | "restored" | "expired" | string;
  title: string;
  description?: string | null;
  created_at: string;
  redeemed_at?: string | null;
};

export type LoyaltyDashboard = {
  points: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  completedHaircuts: number;
  pointsDebt: number;
  pointsPerHaircut: number;
  progressPercent: number;
  nextReward: LoyaltyReward | null;
  pointsToNextReward: number;
  transactions: LoyaltyTransaction[];
  rewards: LoyaltyReward[];
  availableRewards: LoyaltyReward[];
  upcomingRewards: LoyaltyReward[];
  redeemedRewards: RewardHistoryItem[];
  reservedRewards: RewardHistoryItem[];
  rewardHistory: RewardHistoryItem[];
};

export async function fetchMyLoyalty(barberId?: string | number | null): Promise<LoyaltyDashboard> {
  const suffix = barberId != null && String(barberId).trim()
    ? `?barberId=${encodeURIComponent(String(barberId))}`
    : "";
  const data = await fetchAppJson<Partial<LoyaltyDashboard>>(`/api/loyalty/me${suffix}`);

  return {
    points: Number(data.points) || 0,
    lifetimeEarned: Number(data.lifetimeEarned) || 0,
    lifetimeRedeemed: Number(data.lifetimeRedeemed) || 0,
    completedHaircuts: Number(data.completedHaircuts) || 0,
    pointsDebt: Number(data.pointsDebt) || 0,
    pointsPerHaircut: Number(data.pointsPerHaircut) || 5,
    progressPercent: Number(data.progressPercent) || 0,
    nextReward: data.nextReward || null,
    pointsToNextReward: Number(data.pointsToNextReward) || 0,
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    rewards: Array.isArray(data.rewards) ? data.rewards : [],
    availableRewards: Array.isArray(data.availableRewards) ? data.availableRewards : [],
    upcomingRewards: Array.isArray(data.upcomingRewards) ? data.upcomingRewards : [],
    redeemedRewards: Array.isArray(data.redeemedRewards) ? data.redeemedRewards : [],
    reservedRewards: Array.isArray(data.reservedRewards) ? data.reservedRewards : [],
    rewardHistory: Array.isArray(data.rewardHistory) ? data.rewardHistory : [],
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
