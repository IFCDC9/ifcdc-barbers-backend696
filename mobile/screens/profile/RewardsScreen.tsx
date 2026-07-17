import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import {
  fetchMyLoyalty,
  type LoyaltyDashboard,
  type LoyaltyReward,
} from "../../services/loyaltyApi";
import { useAuthenticatedLoad } from "../../hooks/useAuthenticatedLoad";
import { theme } from "../../constants/theme";

const EMPTY: LoyaltyDashboard = {
  points: 0,
  lifetimeEarned: 0,
  lifetimeRedeemed: 0,
  completedHaircuts: 0,
  pointsDebt: 0,
  pointsPerHaircut: 5,
  progressPercent: 0,
  nextReward: null,
  pointsToNextReward: 0,
  transactions: [],
  rewards: [],
  availableRewards: [],
  upcomingRewards: [],
  redeemedRewards: [],
  reservedRewards: [],
  rewardHistory: [],
};

function RewardCard({
  reward,
  locked = false,
}: {
  reward: LoyaltyReward;
  locked?: boolean;
}) {
  const expires = reward.expires_at
    ? new Date(reward.expires_at).toLocaleDateString()
    : null;
  return (
    <ProfileCard style={styles.rewardCard}>
      <View style={styles.rewardHeading}>
        <Text style={styles.rewardIcon}>{locked ? "🔒" : "✓"}</Text>
        <View style={styles.rewardCopy}>
          <Text style={styles.rewardTitle}>{reward.title}</Text>
          {reward.description ? <Text style={styles.rewardDesc}>{reward.description}</Text> : null}
        </View>
        <Text style={styles.rewardCost}>{reward.points_cost} pts</Text>
      </View>
      {expires ? <Text style={styles.meta}>Expires {expires}</Text> : null}
      {!locked ? <Text style={styles.checkoutHint}>Choose this reward during booking checkout.</Text> : null}
    </ProfileCard>
  );
}

export default function RewardsScreen() {
  const [dashboard, setDashboard] = useState<LoyaltyDashboard>(EMPTY);

  const { loading, error, needsSignIn, loadedOnce, reload } = useAuthenticatedLoad(async () => {
    setDashboard(await fetchMyLoyalty());
  }, []);

  const nextHaircutTarget = dashboard.nextReward
    ? Math.ceil(Number(dashboard.nextReward.points_cost) / Math.max(1, dashboard.pointsPerHaircut))
    : dashboard.completedHaircuts;

  return (
    <ProfileScreenLayout
      title="⭐ Loyalty Rewards"
      subtitle="Earn points on paid, completed appointments"
    >
      {loading && !loadedOnce ? <ScreenLoading label="Loading rewards…" /> : null}
      {needsSignIn ? <ScreenError message="Session expired. Sign out and sign in again." /> : null}
      {error && !needsSignIn ? <ScreenError message={error} onRetry={() => void reload()} /> : null}

      {loadedOnce && !needsSignIn ? (
        <>
          <ProfileCard glow style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>Current Points</Text>
            <Text style={styles.balanceValue}>{dashboard.points}</Text>
            <Text style={styles.haircuts}>
              Completed Haircuts: {dashboard.completedHaircuts}
              {nextHaircutTarget > dashboard.completedHaircuts ? ` of ${nextHaircutTarget}` : ""}
            </Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${dashboard.progressPercent}%` }]} />
            </View>
            {dashboard.nextReward ? (
              <View style={styles.nextBox}>
                <Text style={styles.nextLabel}>Next Reward</Text>
                <Text style={styles.nextTitle}>{dashboard.nextReward.title}</Text>
                <Text style={styles.nextHint}>
                  Only {dashboard.pointsToNextReward} more point{dashboard.pointsToNextReward === 1 ? "" : "s"} to go!
                </Text>
              </View>
            ) : (
              <Text style={styles.nextHint}>You reached every active reward tier.</Text>
            )}
          </ProfileCard>

          <Text style={styles.sectionTitle}>Available Rewards</Text>
          {!dashboard.availableRewards.length ? (
            <ScreenEmpty message="Keep booking — your next reward is getting closer." />
          ) : (
            dashboard.availableRewards.map((reward) => <RewardCard key={reward.id} reward={reward} />)
          )}

          <Text style={styles.sectionTitle}>Upcoming Rewards</Text>
          {dashboard.upcomingRewards.map((reward) => (
            <RewardCard key={reward.id} reward={reward} locked />
          ))}

          <Text style={styles.sectionTitle}>Reserved Rewards</Text>
          {!dashboard.reservedRewards.length ? (
            <Text style={styles.emptyText}>No rewards currently reserved at checkout.</Text>
          ) : (
            dashboard.reservedRewards.map((item) => (
              <ProfileCard key={item.id} style={styles.historyCard}>
                <Text style={styles.rewardTitle}>{item.title}</Text>
                <Text style={styles.meta}>{item.points_spent} points · Reserved</Text>
              </ProfileCard>
            ))
          )}

          <Text style={styles.sectionTitle}>Redeemed Rewards</Text>
          {!dashboard.redeemedRewards.length ? (
            <Text style={styles.emptyText}>Your completed reward redemptions will appear here.</Text>
          ) : (
            dashboard.redeemedRewards.map((item) => (
              <ProfileCard key={item.id} style={styles.historyCard}>
                <Text style={styles.rewardTitle}>{item.title}</Text>
                <Text style={styles.meta}>
                  {item.points_spent} points · {new Date(item.redeemed_at || item.created_at).toLocaleDateString()}
                </Text>
              </ProfileCard>
            ))
          )}

          <Text style={styles.sectionTitle}>Reward History</Text>
          {dashboard.transactions.slice(0, 20).map((item) => (
            <View key={item.id} style={styles.transactionRow}>
              <View style={styles.rewardCopy}>
                <Text style={styles.transactionTitle}>{item.reward_title || item.reason.replace(/_/g, " ")}</Text>
                <Text style={styles.meta}>{new Date(item.created_at).toLocaleDateString()}</Text>
              </View>
              <Text style={[styles.delta, item.delta < 0 && styles.deltaNegative]}>
                {item.delta > 0 ? "+" : ""}{item.delta}
              </Text>
            </View>
          ))}
        </>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  balanceCard: { alignItems: "center", marginBottom: 20, gap: 5 },
  balanceLabel: { color: theme.colors.textMuted, fontSize: 13, fontWeight: "700" },
  balanceValue: { color: theme.colors.gold, fontSize: 46, fontWeight: "900" },
  haircuts: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  progressTrack: {
    width: "100%",
    height: 10,
    borderRadius: 99,
    backgroundColor: "rgba(255,255,255,0.1)",
    overflow: "hidden",
    marginVertical: 8,
  },
  progressFill: { height: "100%", borderRadius: 99, backgroundColor: theme.colors.gold },
  nextBox: { alignItems: "center", gap: 2, marginTop: 4 },
  nextLabel: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "700" },
  nextTitle: { color: theme.colors.text, fontSize: 17, fontWeight: "900", textAlign: "center" },
  nextHint: { color: theme.colors.gold, fontSize: 13, textAlign: "center" },
  sectionTitle: { color: theme.colors.text, fontWeight: "900", fontSize: 17, marginTop: 12, marginBottom: 8 },
  rewardCard: { marginBottom: 10, gap: 6 },
  rewardHeading: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  rewardIcon: { fontSize: 16 },
  rewardCopy: { flex: 1 },
  rewardTitle: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  rewardDesc: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  rewardCost: { color: theme.colors.gold, fontWeight: "800", fontSize: 12 },
  checkoutHint: { color: theme.colors.gold, fontSize: 11, fontWeight: "700" },
  meta: { color: theme.colors.textMuted, fontSize: 11, marginTop: 2 },
  emptyText: { color: theme.colors.textMuted, fontSize: 13, marginBottom: 10 },
  historyCard: { marginBottom: 8 },
  transactionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
    paddingVertical: 10,
  },
  transactionTitle: { color: theme.colors.text, fontSize: 13, textTransform: "capitalize" },
  delta: { color: theme.colors.success, fontWeight: "900" },
  deltaNegative: { color: theme.colors.gold },
});
