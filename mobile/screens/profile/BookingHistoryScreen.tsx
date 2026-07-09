import React, { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import BookingStatusBadge from "../../components/BookingStatusBadge";
import { fetchMyBookings, type BookingRow } from "../../services/profileApi";
import { removeBookingFromHistory } from "../../services/bookingDetailApi";
import { confirmDelete } from "../../utils/confirmDelete";
import { useAuthenticatedLoad } from "../../hooks/useAuthenticatedLoad";
import {
  bookingRemovalBlockedMessage,
  canUserRemoveBookingFromHistory,
} from "../../utils/bookingOpsAccess";
import {
  formatBookingDateTime,
  formatMoney,
} from "../../utils/bookingDisplay";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { UX } from "../../utils/uxCopy";
import { theme } from "../../constants/theme";

function BookingCard({
  row,
  onPress,
  onRemove,
}: {
  row: BookingRow;
  onPress: () => void;
  onRemove?: () => void;
}) {
  const when = formatBookingDateTime(row.date, row.time, row.created_at);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onRemove}
      style={({ pressed }) => [pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${row.service || "appointment"} on ${when}`}
    >
      <ProfileCard style={styles.bookingCard}>
        <View style={styles.cardHeader}>
          <Text style={styles.bookingService} numberOfLines={1}>
            {row.service || "Appointment"}
          </Text>
          <BookingStatusBadge
            paymentStatus={row.payment_status}
            bookingStatus={row.booking_status}
            compact
          />
        </View>
        <Text style={styles.bookingMeta} numberOfLines={2}>
          {row.barber_name || "Barber"} · {when}
        </Text>
        <View style={styles.bookingFooter}>
          <Text style={styles.bookingTotal}>{formatMoney(row.total_amount)}</Text>
          <Text style={styles.chevron}>›</Text>
        </View>
      </ProfileCard>
    </Pressable>
  );
}

export default function BookingHistoryScreen({ standalone = false }: { standalone?: boolean }) {
  const navigation = useNavigation<{ navigate: (route: string, params?: unknown) => void }>();
  const [rows, setRows] = useState<BookingRow[]>([]);

  const { loading, error, needsSignIn, reload } = useAuthenticatedLoad(async () => {
    setRows(await fetchMyBookings());
  }, []);

  const load = useCallback(() => {
    void reload();
  }, [reload]);

  const removeRow = useCallback(
    async (row: BookingRow) => {
      if (!canUserRemoveBookingFromHistory(row)) {
        Alert.alert("Cannot remove", bookingRemovalBlockedMessage(row));
        return;
      }
      if (!(await confirmDelete())) return;
      try {
        await removeBookingFromHistory(String(row.id));
        await load();
      } catch (e) {
        Alert.alert("Remove failed", userFacingApiError(e));
      }
    },
    [load],
  );

  return (
    <ProfileScreenLayout
      title={standalone ? "Appointments" : "Booking History"}
      subtitle="Your appointments · long-press to remove unpaid items"
      standalone={standalone}
    >
      {loading ? <ScreenLoading /> : null}
      {needsSignIn ? (
        <ScreenError message="Session expired. Sign out and sign in again from the app home screen." />
      ) : null}
      {error && !needsSignIn ? <ScreenError message={error} onRetry={load} /> : null}
      {!loading && !error && !needsSignIn && rows.length === 0 ? (
        <ScreenEmpty message={UX.emptyAppointments} />
      ) : null}
      <View style={styles.list}>
        {rows.map((row) => (
          <BookingCard
            key={String(row.id)}
            row={row}
            onPress={() => navigation.navigate("BookingDetail", { bookingId: String(row.id) })}
            onRemove={() => void removeRow(row)}
          />
        ))}
      </View>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  cardPressed: { opacity: 0.88 },
  bookingCard: { gap: 6 },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  bookingService: { color: theme.colors.text, fontSize: 17, fontWeight: "700", flex: 1 },
  bookingMeta: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
  bookingFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  bookingTotal: { color: theme.colors.gold, fontWeight: "800", fontSize: 16 },
  chevron: { color: theme.colors.gold, fontSize: 22, fontWeight: "300" },
});
