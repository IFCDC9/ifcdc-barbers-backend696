import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import StaffRosterGuard from "../../components/StaffRosterGuard";
import {
  fetchBarberBillingSummary,
  fetchBarberProfile,
  fetchBarberServices,
  type BarberProfile,
  type BarberServiceRow,
} from "../../services/barberStaffApi";
import { fetchBarberSchedule } from "../../services/barberScheduleApi";
import { deleteAdminBooking } from "../../services/adminBookingApi";
import { removeBookingFromHistory } from "../../services/bookingDetailApi";
import { fetchAdminBookings, type BookingRow } from "../../services/profileApi";
import { useAuth } from "../../services/authContext";
import { confirmDelete } from "../../utils/confirmDelete";
import {
  bookingRemovalBlockedMessage,
  canPerformBookingDestructiveOps,
  canUserRemoveBookingFromHistory,
} from "../../utils/bookingOpsAccess";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { summarizeSchedule } from "../../utils/scheduleModel";
import {
  displayCustomerName,
  formatBookingDateTime,
} from "../../utils/bookingDisplay";
import { UX } from "../../utils/uxCopy";
import { ScreenLoading } from "../../components/LoadingState";
import { theme } from "../../constants/theme";
import ShareButton from "../../components/ShareButton";
import {
  APP_BRAND_NAME,
  buildBarberShareMessage,
} from "../../utils/shareContent";

export type BarberDetailParams = {
  barberId: string;
  barberName: string;
};

type DetailRoute = RouteProp<{ BarberDetail: BarberDetailParams }, "BarberDetail">;

type NavParams = {
  BarberEdit: BarberDetailParams;
  EditBarberSchedule: BarberDetailParams;
  BarberServices: BarberDetailParams;
  BarberGallery: BarberDetailParams;
  BarberPortfolio: { slugOrId: string; barberName?: string };
  AdminBookings: { barberId?: string; barberName?: string } | undefined;
  BookingDetail: { bookingId: string };
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <ProfileCard style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </ProfileCard>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function BarberDetailInner() {
  const navigation = useNavigation<StackNavigationProp<NavParams>>();
  const route = useRoute<DetailRoute>();
  const { barberId, barberName } = route.params;
  const { user, token } = useAuth();
  const canAdminDelete = canPerformBookingDestructiveOps(user, token);

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<BarberProfile | null>(null);
  const [services, setServices] = useState<BarberServiceRow[]>([]);
  const [scheduleSummary, setScheduleSummary] = useState<string>("—");
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [bookingCount, setBookingCount] = useState<number | null>(null);
  const [statusLine, setStatusLine] = useState("—");
  const [showAllBookings, setShowAllBookings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [prof, svc, sched, billing] = await Promise.all([
        fetchBarberProfile(barberId),
        fetchBarberServices(barberId),
        fetchBarberSchedule(barberId).catch(() => null),
        fetchBarberBillingSummary(barberId),
      ]);
      setProfile(prof);
      setServices(svc);
      if (sched) {
        const s = summarizeSchedule(sched);
        setScheduleSummary(`${s.workingDays} · ${s.hours} · ${s.interval}`);
      } else {
        setScheduleSummary(UX.scheduleNotSet);
      }
      if (billing) {
        setBookingCount(billing.totalBookings ?? null);
        setStatusLine(
          `Tier: ${billing.subscription_tier || "free"} · AURA: ${billing.aura_available ? "on" : "off"}`,
        );
      }

      try {
        const all = await fetchAdminBookings();
        const filtered = all.filter(
          (b) =>
            String(b.barber_id || "") === barberId ||
            String(b.barber_name || "").toLowerCase() === barberName.toLowerCase(),
        );
        setBookings(filtered);
      } catch {
        setBookings([]);
      }
    } finally {
      setLoading(false);
    }
  }, [barberId, barberName]);

  useEffect(() => {
    void load();
  }, [load]);

  const displayName = profile?.name || barberName;
  const visibleBookings = showAllBookings ? bookings : bookings.slice(0, 5);

  const removeBookingRow = useCallback(
    async (b: BookingRow) => {
      if (canAdminDelete) {
        if (!(await confirmDelete())) return;
        try {
          await deleteAdminBooking(String(b.id));
          await load();
        } catch (e) {
          Alert.alert("Delete failed", userFacingApiError(e));
        }
        return;
      }
      if (!canUserRemoveBookingFromHistory(b)) {
        Alert.alert("Cannot remove", bookingRemovalBlockedMessage(b));
        return;
      }
      if (!(await confirmDelete())) return;
      try {
        await removeBookingFromHistory(String(b.id));
        await load();
      } catch (e) {
        Alert.alert("Remove failed", userFacingApiError(e));
      }
    },
    [canAdminDelete, load],
  );

  return (
    <ProfileScreenLayout title={displayName} subtitle="Barber detail">
      {loading ? <ScreenLoading /> : null}

      {!loading ? (
        <>
          <Section title="Profile">
            <Meta label="Name" value={displayName} />
            {profile?.phone ? <Meta label="Phone" value={profile.phone} /> : null}
            {profile?.location ? <Meta label="Location" value={profile.location} /> : null}
            {profile?.bio ? <Meta label="Bio" value={profile.bio} /> : null}
            <Meta label="Status" value={statusLine} />
            <View style={styles.shareRow}>
              <ShareButton
                title={`${displayName} · ${APP_BRAND_NAME}`}
                message={buildBarberShareMessage({
                  barberName: displayName,
                  shopName: profile?.location || null,
                  bio: profile?.bio || null,
                })}
                label="Share barber"
              />
            </View>
          </Section>

          <Section title="Schedule controls">
            <Text style={styles.body}>{scheduleSummary}</Text>
          </Section>

          <Section title="Services">
            {services.length === 0 ? (
              <Text style={styles.body}>No services listed.</Text>
            ) : (
              services.map((s) => (
                <Text key={String(s.id)} style={styles.body}>
                  {s.name || "Service"} · ${Number(s.price || 0).toFixed(2)} ·{" "}
                  {s.duration_minutes || 30} min
                  {s.is_active === false ? " (inactive)" : ""}
                </Text>
              ))
            )}
          </Section>

          <Section title="Bookings">
            <Meta
              label="Total"
              value={String(bookingCount ?? bookings.length)}
            />
            {visibleBookings.length === 0 ? (
              <Text style={styles.body}>No bookings found for this barber.</Text>
            ) : (
              visibleBookings.map((b) => (
                <Pressable
                  key={String(b.id)}
                  onPress={() =>
                    navigation.navigate("BookingDetail", { bookingId: String(b.id) })
                  }
                  onLongPress={() => void removeBookingRow(b)}
                  style={({ pressed }) => [styles.bookingRow, pressed && styles.bookingRowPressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open booking ${b.service || "appointment"}`}
                >
                  <Text style={styles.bookingRowText} numberOfLines={2}>
                    {b.service || "Appointment"} ·{" "}
                    {formatBookingDateTime(b.date, b.time, b.created_at)} ·{" "}
                    {displayCustomerName(b.customer_name, b.customer_email)}
                  </Text>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              ))
            )}
            {bookings.length > 5 && !showAllBookings ? (
              <Text style={styles.link} onPress={() => setShowAllBookings(true)}>
                Show all {bookings.length} bookings
              </Text>
            ) : null}
          </Section>

          <View style={styles.actions}>
            <GlowButton
              label="Edit profile"
              onPress={() => navigation.navigate("BarberEdit", { barberId, barberName: displayName })}
            />
            <View style={{ height: 10 }} />
            <GlowButton
              label="Haircut gallery"
              variant="outline"
              onPress={() => navigation.navigate("BarberGallery", { barberId, barberName: displayName })}
            />
            <View style={{ height: 10 }} />
            <GlowButton
              label="View public portfolio"
              variant="outline"
              onPress={() => navigation.navigate("BarberPortfolio", { slugOrId: barberId, barberName: displayName })}
            />
            <View style={{ height: 10 }} />
            <GlowButton
              label="Manage Services"
              variant="outline"
              onPress={() => navigation.navigate("BarberServices", { barberId, barberName: displayName })}
            />
            <View style={{ height: 10 }} />
            <GlowButton
              label="Edit Schedule"
              variant="outline"
              onPress={() => navigation.navigate("EditBarberSchedule", { barberId, barberName: displayName })}
            />
            <View style={{ height: 10 }} />
            <GlowButton
              label="View Bookings"
              variant="outline"
              onPress={() => {
                const names = navigation.getState().routeNames as string[];
                if (names.includes("AdminBookings")) {
                  navigation.navigate("AdminBookings", { barberId, barberName: displayName });
                } else {
                  setShowAllBookings(true);
                }
              }}
            />
          </View>
        </>
      ) : null}
    </ProfileScreenLayout>
  );
}

export default function BarberDetailScreen() {
  return (
    <StaffRosterGuard>
      <BarberDetailInner />
    </StaffRosterGuard>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  sectionTitle: { color: theme.colors.gold, fontSize: 15, fontWeight: "800", marginBottom: 4 },
  metaRow: { gap: 2 },
  metaLabel: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "600", textTransform: "uppercase" },
  metaValue: { color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  body: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
  bookingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  bookingRowPressed: { opacity: 0.7 },
  bookingRowText: { color: theme.colors.text, fontSize: 14, lineHeight: 20, flex: 1 },
  chevron: { color: theme.colors.gold, fontSize: 20, fontWeight: "300" },
  link: { color: theme.colors.gold, fontSize: 14, fontWeight: "600", marginTop: 6 },
  actions: { marginTop: 8 },
  shareRow: { marginTop: 8 },
});
