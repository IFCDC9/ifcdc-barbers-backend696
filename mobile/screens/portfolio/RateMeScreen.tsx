import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import { fetchReviewableBookings } from "../../services/reviewableBookingsApi";
import { useAuthenticatedLoad } from "../../hooks/useAuthenticatedLoad";
import { theme } from "../../constants/theme";
import type { ProfileStackParamList } from "../../navigation/ProfileStack";

type ReviewableBooking = {
  id: string;
  barberId: string;
  barberName: string;
  service: string;
  date: string;
  time: string;
};

export default function RateMeScreen() {
  const navigation = useNavigation<StackNavigationProp<ProfileStackParamList>>();
  const [rows, setRows] = useState<ReviewableBooking[]>([]);

  const { loading, error, needsSignIn, loadedOnce, reload } = useAuthenticatedLoad(async () => {
    const list = await fetchReviewableBookings();
    setRows(
      list.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        barberId: String(row.barberId ?? row.barber_id ?? ""),
        barberName: String(row.barberName ?? row.barber_name ?? "Your barber"),
        service: String(row.service ?? "Appointment"),
        date: String(row.date ?? ""),
        time: String(row.time ?? ""),
      })),
    );
  }, []);

  return (
    <ProfileScreenLayout title="Rate Me" subtitle="Share feedback after completed visits" onBack={() => navigation.goBack()}>
      {loading && !loadedOnce ? <ScreenLoading label="Loading…" /> : null}
      {needsSignIn ? <ScreenError message="Session expired. Sign out and sign in again." /> : null}
      {error && !needsSignIn ? <ScreenError message={error} onRetry={() => void reload()} /> : null}
      {(loadedOnce || (!loading && !error && !needsSignIn)) && !rows.length ? (
        <ScreenEmpty message="No completed visits waiting for a review. Book a cut, then come back after your appointment is marked complete." />
      ) : null}

      {rows.map((row) => (
        <ProfileCard key={row.id} style={styles.card}>
          <Text style={styles.service}>{row.service}</Text>
          <Text style={styles.meta}>
            {row.barberName} · {row.date} {row.time}
          </Text>
          <GlowButton
            label="Leave a review"
            onPress={() =>
              navigation.navigate("BookingReview", {
                bookingId: row.id,
                barberId: row.barberId,
                barberName: row.barberName,
                serviceName: row.service,
              })
            }
          />
        </ProfileCard>
      ))}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12, gap: 8 },
  service: { color: theme.colors.text, fontWeight: "800", fontSize: 16 },
  meta: { color: theme.colors.textMuted, fontSize: 13, marginBottom: 4 },
});
