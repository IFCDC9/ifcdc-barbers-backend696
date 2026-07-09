import React, { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import { fetchMyLoyalty, redeemReward, type LoyaltyReward } from "../../services/loyaltyApi";
import { useAuthenticatedLoad } from "../../hooks/useAuthenticatedLoad";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";

export default function RewardsScreen() {
  const navigation = useNavigation();
  const [points, setPoints] = useState(0);
  const [lifetime, setLifetime] = useState(0);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { loading, error, needsSignIn, loadedOnce, reload } = useAuthenticatedLoad(async () => {
    const data = await fetchMyLoyalty();
    setPoints(data.points);
    setLifetime(data.lifetimeEarned);
    setRewards(data.rewards);
  }, []);

  const onRedeem = async (reward: LoyaltyReward) => {
    setBusyId(reward.id);
    try {
      const result = await redeemReward(reward.id);
      setPoints(result.points);
      Alert.alert("Redeemed", result.message);
      await reload();
    } catch (e) {
      Alert.alert("Could not redeem", userFacingApiError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ProfileScreenLayout title="Rewards" subtitle="Earn points after every completed booking" onBack={() => navigation.goBack()}>
      {loading && !loadedOnce ? <ScreenLoading label="Loading rewards…" /> : null}
      {needsSignIn ? <ScreenError message="Session expired. Sign out and sign in again." /> : null}
      {error && !needsSignIn ? (
        <ScreenError message={error} onRetry={() => void reload()} />
      ) : null}

      {(loadedOnce || (!loading && !error && !needsSignIn)) ? (
        <>
          <ProfileCard glow style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>Your points</Text>
            <Text style={styles.balanceValue}>{points}</Text>
            <Text style={styles.balanceHint}>{lifetime} earned lifetime · 1 point per $1 spent</Text>
          </ProfileCard>

          <Text style={styles.sectionTitle}>Redeem</Text>
          {!rewards.length ? (
            <ScreenEmpty message="No rewards available yet. Check back soon — your barber may add offers here." />
          ) : null}
          {rewards.map((reward) => {
            const cost = Number(reward.points_cost) || 0;
            const canRedeem = points >= cost;
            return (
              <ProfileCard key={reward.id} style={styles.rewardCard}>
                <Text style={styles.rewardTitle}>{reward.title}</Text>
                {reward.description ? <Text style={styles.rewardDesc}>{reward.description}</Text> : null}
                <Text style={styles.rewardCost}>{cost} points</Text>
                <GlowButton
                  label={canRedeem ? "Redeem" : `Need ${cost - points} more`}
                  onPress={() => void onRedeem(reward)}
                  disabled={!canRedeem || busyId === reward.id}
                  variant={canRedeem ? "primary" : "outline"}
                />
              </ProfileCard>
            );
          })}
        </>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  balanceCard: { alignItems: "center", marginBottom: 16, gap: 4 },
  balanceLabel: { color: theme.colors.textMuted, fontSize: 13, fontWeight: "600" },
  balanceValue: { color: theme.colors.gold, fontSize: 42, fontWeight: "900" },
  balanceHint: { color: theme.colors.textMuted, fontSize: 12, textAlign: "center" },
  sectionTitle: { color: theme.colors.text, fontWeight: "800", fontSize: 16, marginBottom: 8 },
  rewardCard: { marginBottom: 10, gap: 6 },
  rewardTitle: { color: theme.colors.text, fontWeight: "800", fontSize: 15 },
  rewardDesc: { color: theme.colors.textMuted, fontSize: 13 },
  rewardCost: { color: theme.colors.gold, fontWeight: "700", fontSize: 13, marginBottom: 4 },
});
