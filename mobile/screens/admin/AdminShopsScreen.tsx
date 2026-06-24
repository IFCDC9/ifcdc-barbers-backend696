import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { ScreenEmpty, ScreenError, ScreenLoading } from "../../components/LoadingState";
import { theme } from "../../constants/theme";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { useAuth } from "../../services/authContext";
import {
  approveAdminShop,
  fetchAdminShopDashboard,
  fetchAdminShops,
  patchAdminShopAccountStatus,
  rejectAdminShop,
  type AdminShopDashboard,
  type AdminShopRow,
} from "../../services/adminShopsApi";
import type { AdminStackParamList } from "../../navigation/AdminStack";

type Nav = StackNavigationProp<AdminStackParamList, "AdminShop">;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function AdminShopsScreen() {
  const navigation = useNavigation<Nav>();
  const { isPlatformAdmin } = useAuth();
  const [dashboard, setDashboard] = useState<AdminShopDashboard | null>(null);
  const [pending, setPending] = useState<AdminShopRow[]>([]);
  const [rows, setRows] = useState<AdminShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isPlatformAdmin) {
        const dash = await fetchAdminShopDashboard();
        setDashboard(dash.dashboard);
        setPending(dash.pendingQueue);
      }
      const shops = await fetchAdminShops({
        shop: shop.trim() || undefined,
        status: status || undefined,
      });
      setRows(shops);
    } catch (e) {
      setError(userFacingApiError(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [isPlatformAdmin, shop, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (id: string, plan: string) => {
    try {
      await approveAdminShop(id, plan);
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    }
  };

  const reject = async (id: string) => {
    try {
      await rejectAdminShop(id, "Rejected by Super Admin");
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    }
  };

  const suspendShop = async (id: string) => {
    try {
      await patchAdminShopAccountStatus(id, "suspended");
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    }
  };

  const reactivateShop = async (id: string) => {
    try {
      await patchAdminShopAccountStatus(id, "active");
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    }
  };

  const shopSuspended = (row: AdminShopRow) => {
    const s = `${row.accountStatus} ${row.approvalStatus}`.toLowerCase();
    return s.includes("suspend") || s.includes("disabled") || s.includes("reject");
  };

  return (
    <ProfileScreenLayout title="Shops & locations" subtitle="Global platform shop management">
      <ScrollView contentContainerStyle={styles.scroll}>
        {isPlatformAdmin && dashboard ? (
          <ProfileCard>
            <Text style={styles.sectionTitle}>Platform overview</Text>
            <View style={styles.statsRow}>
              <Stat label="Shops" value={dashboard.totalShops} />
              <Stat label="Active" value={dashboard.activeShops} />
              <Stat label="Pending" value={dashboard.pendingShops} />
              <Stat label="Suspended" value={dashboard.suspendedShops} />
            </View>
            <Text style={styles.meta}>
              MRR ${Number(dashboard.monthlyRecurringRevenue || 0).toFixed(2)} · Platform fees $
              {Number(dashboard.platformFeeRevenue || 0).toFixed(2)}
            </Text>
          </ProfileCard>
        ) : null}

        {isPlatformAdmin && pending.length > 0 ? (
          <ProfileCard style={styles.section}>
            <Text style={styles.sectionTitle}>Pending approval ({pending.length})</Text>
            {pending.map((row) => (
              <View key={`pending-${row.id}`} style={styles.pendingRow}>
                <Text style={styles.name}>{row.shopName}</Text>
                <Text style={styles.meta}>{row.ownerEmail}</Text>
                <View style={styles.actions}>
                  <Pressable style={styles.approveBtn} onPress={() => void approve(row.id, "free")}>
                    <Text style={styles.actionText}>Free</Text>
                  </Pressable>
                  <Pressable style={styles.approveBtn} onPress={() => void approve(row.id, "trial")}>
                    <Text style={styles.actionText}>Trial</Text>
                  </Pressable>
                  <Pressable style={styles.approveBtn} onPress={() => void approve(row.id, "paid")}>
                    <Text style={styles.actionText}>Paid</Text>
                  </Pressable>
                  <Pressable style={styles.approveBtn} onPress={() => void approve(row.id, "lifetime_free")}>
                    <Text style={styles.actionText}>Lifetime</Text>
                  </Pressable>
                  <Pressable style={styles.rejectBtn} onPress={() => void reject(row.id)}>
                    <Text style={styles.actionText}>Reject</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </ProfileCard>
        ) : null}

        <ProfileCard style={styles.section}>
          <Text style={styles.sectionTitle}>Filters</Text>
          <TextInput
            style={styles.input}
            placeholder="Shop name"
            value={shop}
            onChangeText={setShop}
            placeholderTextColor={theme.colors.textMuted}
          />
          <View style={styles.chips}>
            {["", "active", "pending", "suspended", "trial", "paid", "free"].map((v) => (
              <Pressable key={v || "all"} style={[styles.chip, status === v && styles.chipActive]} onPress={() => setStatus(v)}>
                <Text style={styles.chipText}>{v || "All"}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.applyBtn} onPress={() => void load()}>
            <Text style={styles.applyBtnText}>Apply filters</Text>
          </Pressable>
        </ProfileCard>

        {loading ? <ScreenLoading /> : null}
        {error ? <ScreenError message={error} /> : null}
        {!loading && !error && rows.length === 0 ? <ScreenEmpty message="No shops found." /> : null}

        {rows.map((row) => (
          <Pressable key={row.id} onPress={() => navigation.navigate("AdminShopDetail", { shopId: row.id, shopName: row.shopName })}>
            <ProfileCard style={styles.card}>
              <Text style={styles.name}>{row.shopName}</Text>
              <Text style={styles.meta}>{row.locationLabel}</Text>
              <Text style={styles.meta}>
                {row.accountStatus} · {row.accessPlan} · {row.subscriptionStatus}
              </Text>
              <Text style={styles.meta}>
                Barbers {row.barberCount} · Bookings {row.bookingCount} · Revenue ${Number(row.totalRevenue || 0).toFixed(2)}
              </Text>
              {isPlatformAdmin ? (
                <View style={styles.actions}>
                  {row.pendingApproval ? (
                    <>
                      <Pressable style={styles.approveBtn} onPress={() => void approve(row.id, "free")}>
                        <Text style={styles.actionText}>Approve</Text>
                      </Pressable>
                      <Pressable style={styles.rejectBtn} onPress={() => void reject(row.id)}>
                        <Text style={styles.actionText}>Reject</Text>
                      </Pressable>
                    </>
                  ) : shopSuspended(row) ? (
                    <Pressable style={styles.approveBtn} onPress={() => void reactivateShop(row.id)}>
                      <Text style={styles.actionText}>Reactivate</Text>
                    </Pressable>
                  ) : (
                    <Pressable style={styles.rejectBtn} onPress={() => void suspendShop(row.id)}>
                      <Text style={styles.actionText}>Suspend</Text>
                    </Pressable>
                  )}
                </View>
              ) : null}
            </ProfileCard>
          </Pressable>
        ))}
      </ScrollView>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: 12, paddingBottom: 24 },
  section: { marginTop: 4 },
  sectionTitle: { color: theme.colors.gold, fontWeight: "800", marginBottom: 8 },
  statsRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  stat: { minWidth: 72, alignItems: "center" },
  statValue: { color: theme.colors.text, fontWeight: "800", fontSize: 18 },
  statLabel: { color: theme.colors.textMuted, fontSize: 11 },
  name: { color: theme.colors.text, fontWeight: "700", fontSize: 16 },
  meta: { color: theme.colors.textMuted, fontSize: 13, marginTop: 4 },
  card: { marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    padding: 10,
    color: theme.colors.text,
    marginBottom: 8,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { borderColor: theme.colors.gold, backgroundColor: "rgba(245,200,66,0.12)" },
  chipText: { color: theme.colors.text, fontSize: 12 },
  applyBtn: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.gold,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  applyBtnText: { color: "#111", fontWeight: "800" },
  pendingRow: { marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  approveBtn: { backgroundColor: "rgba(34,197,94,0.2)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  rejectBtn: { backgroundColor: "rgba(248,113,113,0.2)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  actionText: { color: theme.colors.text, fontSize: 12, fontWeight: "700" },
});
