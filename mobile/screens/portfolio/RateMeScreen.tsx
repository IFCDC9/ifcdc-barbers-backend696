import React, { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import { apiFetch } from "../../services/api";
import { userFacingApiError } from "../../utils/userFacingApiError";
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

async function fetchReviewableBookings(): Promise<ReviewableBooking[]> {
  const res = await apiFetch("/api/me/reviewable-bookings");
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.message || "Could not load reviews");
  return (Array.isArray(data.bookings) ? data.bookings : []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    barberId: String(row.barberId ?? row.barber_id ?? ""),
    barberName: String(row.barberName ?? row.barber_name ?? "Your barber"),
    service: String(row.service ?? "Appointment"),
    date: String(row.date ?? ""),
    time: String(row.time ?? ""),
  }));
}

export default function RateMeScreen() {
  const navigation = useNavigation<StackNavigationProp<ProfileStackParamList>>();
  const [rows, setRows] = useState<ReviewableBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchReviewableBookings());
    } catch (e) {
      setError(userFacingApiError(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProfileScreenLayout title="Rate Me" subtitle="Share feedback after completed visits" onBack={() => navigation.goBack()}>
      {loading ? <ScreenLoading label="Loading…" /> : null}
      {error ? <ScreenError message={error} onRetry={() => void load()} /> : null}
      {!loading && !error && !rows.length ? (
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
