import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { ScreenLoading, ScreenError } from "../../components/LoadingState";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { fetchAdminStats, fetchHubSpotHqKpis, type AdminStats, type HubSpotHqKpis } from "../../services/adminApi";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";

function money(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <ProfileCard style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </ProfileCard>
  );
}

export default function AdminAnalyticsScreen() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [hubspot, setHubspot] = useState<HubSpotHqKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([
        fetchAdminStats(),
        fetchHubSpotHqKpis(30).catch(() => null),
      ]);
      setStats(s);
      setHubspot(h);
    } catch (e) {
      setError(userFacingApiError(e));
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProfileScreenLayout title="Platform analytics" subtitle="Revenue, bookings, and HubSpot CRM">
      {loading ? <ScreenLoading /> : null}
      {error ? <ScreenError message={error} /> : null}
      {stats ? (
        <>
          <StatRow label="Total bookings" value={String(stats.allBookingsCount ?? stats.totalBookings ?? 0)} />
          <StatRow label="Paid bookings" value={String(stats.paidBookingsCount ?? 0)} />
          <StatRow label="Confirmed" value={String(stats.confirmedBookingsCount ?? 0)} />
          <StatRow label="Gross revenue" value={money(stats.totalRevenue)} />
          <StatRow label="Average booking" value={money(stats.avgBooking)} />
          <StatRow label="Highest payment" value={money(stats.highestPayment)} />
          {stats.lastPaymentAt ? (
            <ProfileCard>
              <Text style={styles.note}>Last payment: {new Date(stats.lastPaymentAt).toLocaleString()}</Text>
            </ProfileCard>
          ) : null}
        </>
      ) : null}
      {hubspot?.enabled ? (
        <>
          <Text style={styles.section}>HubSpot CRM ({hubspot.windowDays}d)</Text>
          <StatRow
            label="New customers"
            value={String(hubspot.customerGrowth?.newCustomers ?? 0)}
          />
          <StatRow
            label="Returning rate"
            value={`${hubspot.returningCustomerRate?.ratePercent ?? 0}%`}
          />
          <StatRow
            label="Appointments"
            value={String(hubspot.appointmentVolume?.totals?.appointments ?? 0)}
          />
          <StatRow label="Period revenue" value={money(hubspot.revenueTrends?.totals?.revenue)} />
          <StatRow
            label="Contacts synced"
            value={String(hubspot.hubspotSyncHealth?.contacts?.synced ?? 0)}
          />
          {(hubspot.topBarbers || []).slice(0, 3).map((b) => (
            <StatRow
              key={`b-${b.barberId}`}
              label={`Top barber: ${b.name}`}
              value={money(b.revenue)}
            />
          ))}
          {(hubspot.topShops || []).slice(0, 3).map((s) => (
            <StatRow
              key={`s-${s.businessId}`}
              label={`Top shop: ${s.name}`}
              value={money(s.revenue)}
            />
          ))}
        </>
      ) : hubspot && hubspot.enabled === false ? (
        <ProfileCard>
          <Text style={styles.note}>{hubspot.message || "HubSpot HQ analytics is disabled."}</Text>
        </ProfileCard>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  stat: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statLabel: { color: theme.colors.textMuted, fontSize: 14, flex: 1 },
  statValue: { color: theme.colors.gold, fontSize: 16, fontWeight: "800" },
  note: { color: theme.colors.textMuted, fontSize: 13 },
  section: {
    color: theme.colors.gold,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 12,
    marginBottom: 4,
  },
});
