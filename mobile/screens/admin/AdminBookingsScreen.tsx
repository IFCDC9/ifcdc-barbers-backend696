import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { ScreenLoading, ScreenEmpty, ScreenError } from "../../components/LoadingState";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import BookingStatusBadge from "../../components/BookingStatusBadge";
import { deleteAdminBooking } from "../../services/adminBookingApi";
import { fetchAdminBookings, type BookingRow } from "../../services/profileApi";
import { useAuth } from "../../services/authContext";
import { confirmDelete } from "../../utils/confirmDelete";
import { canPerformBookingDestructiveOps } from "../../utils/bookingOpsAccess";
import { userFacingApiError } from "../../utils/userFacingApiError";
import {
  displayCustomerEmail,
  displayCustomerName,
  formatBookingDateTime,
  formatMoney,
} from "../../utils/bookingDisplay";
import { maskPhoneForDisplay } from "../../utils/redactPii";
import { theme } from "../../constants/theme";
import type { AdminStackParamList } from "../../navigation/AdminStack";

type BookingsRoute = RouteProp<AdminStackParamList, "AdminBookings">;
type Nav = StackNavigationProp<AdminStackParamList, "AdminBookings">;

function BookingCard({
  row,
  onPress,
  onDelete = () => {},
}: {
  row: BookingRow;
  onPress: () => void;
  onDelete?: (bookingId: string) => void;
}) {
  const when = formatBookingDateTime(row.date, row.time, row.created_at);
  const phoneLabel = row.phone ? maskPhoneForDisplay(String(row.phone)) : null;
  const emailLabel = displayCustomerEmail(row.customer_email);
  const contact =
    phoneLabel ||
    (emailLabel !== "No email on file" && emailLabel !== "Guest customer" ? emailLabel : null) ||
    "No phone on file";
  const customerLine = `${displayCustomerName(row.customer_name, row.customer_email)} · ${contact}`;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => {
        Alert.alert("Delete Booking", "Are you sure?", [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => onDelete(String(row.id)),
          },
        ]);
      }}
      style={({ pressed }) => [pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open booking for ${row.service || "appointment"}`}
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
        <Text style={styles.bookingMeta} numberOfLines={1}>
          {row.barber_name || "Barber"} · {when}
        </Text>
        <Text style={styles.bookingMeta} numberOfLines={1}>
          {customerLine}
        </Text>
        <View style={styles.bookingFooter}>
          <Text style={styles.bookingTotal}>{formatMoney(row.total_amount)}</Text>
          <Text style={styles.chevron}>›</Text>
        </View>
      </ProfileCard>
    </Pressable>
  );
}

export default function AdminBookingsScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<BookingsRoute>();
  const { user, token } = useAuth();
  const canAdminDelete = canPerformBookingDestructiveOps(user, token);
  const filterBarberId = route.params?.barberId;
  const filterBarberName = route.params?.barberName;
  const [rows, setRows] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchAdminBookings());
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

  const filtered = useMemo(() => {
    if (!filterBarberId && !filterBarberName) return rows;
    return rows.filter((b) => {
      if (filterBarberId && String(b.barber_id || "") === String(filterBarberId)) return true;
      if (filterBarberName && String(b.barber_name || "").toLowerCase() === filterBarberName.toLowerCase()) {
        return true;
      }
      return false;
    });
  }, [rows, filterBarberId, filterBarberName]);

  const subtitle = filterBarberName
    ? `Bookings for ${filterBarberName}`
    : "Platform-wide booking management";

  const deleteRow = useCallback(
    async (bookingId: string) => {
      if (!canAdminDelete) return;
      try {
        await deleteAdminBooking(bookingId);
        await load();
      } catch (e) {
        Alert.alert("Delete failed", userFacingApiError(e));
      }
    },
    [canAdminDelete, load],
  );

  return (
    <ProfileScreenLayout title="Bookings" subtitle={subtitle}>
      {loading ? <ScreenLoading /> : null}
      {error ? <ScreenError message={error} /> : null}
      {!loading && !error && filtered.length === 0 ? <ScreenEmpty message="No bookings found." /> : null}
      <View style={styles.list}>
        {filtered.map((row) => (
          <BookingCard
            key={String(row.id)}
            row={row}
            onPress={() =>
              navigation.navigate("AdminBookingDetail", { bookingId: String(row.id) })
            }
            onDelete={
              canAdminDelete
                ? (bookingId) => void deleteRow(bookingId)
                : () => {}
            }
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
  bookingMeta: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 19 },
  bookingFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  bookingTotal: { color: theme.colors.gold, fontWeight: "700", fontSize: 16 },
  chevron: { color: theme.colors.gold, fontSize: 22, fontWeight: "300" },
  error: { color: "#f87171", marginTop: 16 },
  empty: { color: theme.colors.textMuted, fontSize: 14 },
});
