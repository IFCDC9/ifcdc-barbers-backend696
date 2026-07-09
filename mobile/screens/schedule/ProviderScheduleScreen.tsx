import React, { useCallback, useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import BookingStatusBadge from "../../components/BookingStatusBadge";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import {
  fetchProviderAppointments,
  type ProviderAppointment,
} from "../../services/providerAppointmentsApi";
import { formatMoney } from "../../utils/bookingDisplay";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";

export type ProviderScheduleParams = {
  barberId: string;
  barberName: string;
};

type Route = RouteProp<{ ProviderSchedule: ProviderScheduleParams }, "ProviderSchedule">;

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDate(ymd: string, delta: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function AppointmentCard({
  row,
  onPress,
}: {
  row: ProviderAppointment;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && styles.cardPressed]}>
      <ProfileCard style={styles.card}>
        <View style={styles.cardTop}>
          {row.styleImageUrl ? (
            <Image source={{ uri: row.styleImageUrl }} style={styles.thumb} />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Text style={styles.thumbPlaceholderText}>✂</Text>
            </View>
          )}
          <View style={styles.cardBody}>
            <Text style={styles.clientName} numberOfLines={1}>
              {row.customerName || "Client"}
            </Text>
            <Text style={styles.service} numberOfLines={1}>
              {row.service}
            </Text>
            <Text style={styles.when}>
              {row.time} · {formatMoney(row.totalAmount)}
            </Text>
            <BookingStatusBadge
              paymentStatus={row.paymentStatus}
              bookingStatus={row.bookingStatus}
              compact
            />
          </View>
        </View>
        {!["completed", "cancelled", "no_show"].includes(String(row.bookingStatus).toLowerCase()) ? (
          <Text style={styles.actionsHint}>Tap for cancel / reschedule / status</Text>
        ) : null}
      </ProfileCard>
    </Pressable>
  );
}

export default function ProviderScheduleScreen() {
  const navigation = useNavigation<{ navigate: (route: string, params?: object) => void }>();
  const route = useRoute<Route>();
  const { barberId, barberName } = route.params;

  const [date, setDate] = useState(todayYmd);
  const [rows, setRows] = useState<ProviderAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProviderAppointments(barberId, date);
      setRows(data.appointments);
      if (data.date) setDate(data.date);
    } catch (e) {
      setError(userFacingApiError(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [barberId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const isToday = date === todayYmd();
  const title = isToday ? "Today's bookings" : "My schedule";

  return (
    <ProfileScreenLayout title={title} subtitle={barberName} onBack={() => navigation.goBack()}>
      <ProfileCard style={styles.dateNav}>
        <View style={styles.dateRow}>
          <GlowButton label="◀" variant="outline" onPress={() => setDate((d) => shiftDate(d, -1))} />
          <Text style={styles.dateLabel}>{isToday ? `Today · ${date}` : date}</Text>
          <GlowButton label="▶" variant="outline" onPress={() => setDate((d) => shiftDate(d, 1))} />
        </View>
        {!isToday ? (
          <GlowButton label="Jump to today" variant="outline" onPress={() => setDate(todayYmd())} />
        ) : null}
      </ProfileCard>

      {loading ? <ScreenLoading label="Loading appointments…" /> : null}
      {error ? <ScreenError message={error} onRetry={() => void load()} /> : null}
      {!loading && !error && !rows.length ? (
        <ScreenEmpty message="No appointments scheduled for this day." />
      ) : null}

      {rows.map((row) => (
        <AppointmentCard
          key={row.id}
          row={row}
          onPress={() => navigation.navigate("BookingDetail", { bookingId: row.id })}
        />
      ))}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  dateNav: { marginBottom: 12, gap: 10 },
  dateRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  dateLabel: { flex: 1, textAlign: "center", color: theme.colors.text, fontWeight: "700", fontSize: 15 },
  card: { marginBottom: 10 },
  cardPressed: { opacity: 0.92 },
  cardTop: { flexDirection: "row", gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },
  thumbPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: "rgba(255,215,0,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbPlaceholderText: { fontSize: 22 },
  cardBody: { flex: 1, gap: 4 },
  clientName: { color: theme.colors.text, fontWeight: "800", fontSize: 16 },
  service: { color: theme.colors.textMuted, fontSize: 14 },
  when: { color: theme.colors.textMuted, fontSize: 13 },
  actionsHint: { marginTop: 10, color: theme.colors.gold, fontSize: 12, fontWeight: "600" },
});
