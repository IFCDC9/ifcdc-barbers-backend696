import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { ScreenError, ScreenLoading } from "../../components/LoadingState";
import { theme } from "../../constants/theme";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { useAuth } from "../../services/authContext";
import {
  approveAdminShop,
  fetchAdminShopDetail,
  patchAdminShopAccess,
  patchAdminShopAccountStatus,
  rejectAdminShop,
  type AdminShopDetail,
} from "../../services/adminShopsApi";
import type { AdminStackParamList } from "../../navigation/AdminStack";

type Route = RouteProp<AdminStackParamList, "AdminShopDetail">;

function ToggleRow({
  label,
  enabled,
  onPress,
  disabled,
}: {
  label: string;
  enabled: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable style={[styles.toggleRow, disabled && styles.disabled]} onPress={onPress} disabled={disabled}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Text style={[styles.toggleValue, enabled ? styles.on : styles.off]}>{enabled ? "ON" : "OFF"}</Text>
    </Pressable>
  );
}

export default function AdminShopDetailScreen() {
  const route = useRoute<Route>();
  const { shopId } = route.params;
  const { isPlatformAdmin } = useAuth();
  const [detail, setDetail] = useState<AdminShopDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchAdminShopDetail(shopId));
    } catch (e) {
      setError(userFacingApiError(e));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shop = detail?.shop;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (patch: Record<string, unknown>) => {
    if (!isPlatformAdmin) return;
    void run(() => patchAdminShopAccess(shopId, patch));
  };

  return (
    <ProfileScreenLayout title={shop?.shopName || "Shop detail"} subtitle="Monetization & access control">
      <ScrollView contentContainerStyle={styles.scroll}>
        {loading ? <ScreenLoading /> : null}
        {error ? <ScreenError message={error} /> : null}

        {shop ? (
          <>
            <ProfileCard>
              <Text style={styles.sectionTitle}>Overview</Text>
              <Text style={styles.meta}>Owner: {shop.ownerName} · {shop.ownerEmail}</Text>
              <Text style={styles.meta}>Location: {shop.locationLabel}</Text>
              <Text style={styles.meta}>
                Status: {shop.accountStatus} · Approval: {shop.approvalStatus} · Plan: {shop.accessPlan}
              </Text>
              <Text style={styles.meta}>
                Subscription: {shop.subscriptionStatus} · Revenue ${Number(shop.totalRevenue || 0).toFixed(2)} · Fees $
                {Number(shop.platformFees || 0).toFixed(2)}
              </Text>
              <Text style={styles.meta}>
                Barbers {shop.barberCount} · Bookings {shop.bookingCount} · Customers {shop.customerCount}
              </Text>
            </ProfileCard>

            {isPlatformAdmin && shop.pendingApproval ? (
              <ProfileCard style={styles.section}>
                <Text style={styles.sectionTitle}>Approve registration</Text>
                <View style={styles.actions}>
                  {(["free", "trial", "paid", "lifetime_free"] as const).map((plan) => (
                    <Pressable
                      key={plan}
                      style={styles.actionBtn}
                      disabled={busy}
                      onPress={() => void run(() => approveAdminShop(shopId, plan))}
                    >
                      <Text style={styles.actionText}>{plan.replace("_", " ")}</Text>
                    </Pressable>
                  ))}
                  <Pressable
                    style={[styles.actionBtn, styles.rejectBtn]}
                    disabled={busy}
                    onPress={() =>
                      Alert.alert("Reject shop?", "This disables the shop registration.", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Reject", style: "destructive", onPress: () => void run(() => rejectAdminShop(shopId)) },
                      ])
                    }
                  >
                    <Text style={styles.actionText}>Reject</Text>
                  </Pressable>
                </View>
              </ProfileCard>
            ) : null}

            {isPlatformAdmin ? (
              <ProfileCard style={styles.section}>
                <Text style={styles.sectionTitle}>Access controls</Text>
                <ToggleRow label="Bookings" enabled={shop.bookingsEnabled} disabled={busy} onPress={() => toggle({ bookingsEnabled: !shop.bookingsEnabled })} />
                <ToggleRow
                  label="Payment processing"
                  enabled={shop.paymentProcessingEnabled}
                  disabled={busy}
                  onPress={() => toggle({ paymentProcessingEnabled: !shop.paymentProcessingEnabled })}
                />
                <ToggleRow
                  label="Platform fees"
                  enabled={shop.platformFeesEnabled !== false}
                  disabled={busy}
                  onPress={() => toggle({ platformFeesEnabled: shop.platformFeesEnabled === false })}
                />
                <ToggleRow
                  label="Monthly subscriptions"
                  enabled={shop.subscriptionEnabled !== false}
                  disabled={busy}
                  onPress={() => toggle({ subscriptionEnabled: shop.subscriptionEnabled === false })}
                />
                <ToggleRow
                  label="Website access"
                  enabled={shop.websiteAccessEnabled !== false}
                  disabled={busy}
                  onPress={() => toggle({ websiteAccessEnabled: shop.websiteAccessEnabled === false })}
                />
                <ToggleRow
                  label="Mobile app access"
                  enabled={shop.mobileAppAccessEnabled !== false}
                  disabled={busy}
                  onPress={() => toggle({ mobileAppAccessEnabled: shop.mobileAppAccessEnabled === false })}
                />
                <Pressable style={styles.actionBtn} disabled={busy} onPress={() => toggle({ accessPlan: "lifetime_free", subscriptionEnabled: false })}>
                  <Text style={styles.actionText}>Set lifetime free</Text>
                </Pressable>
                <View style={styles.actions}>
                  <Pressable
                    style={styles.actionBtn}
                    disabled={busy}
                    onPress={() =>
                      Alert.alert("Suspend shop?", undefined, [
                        { text: "Cancel", style: "cancel" },
                        { text: "Suspend", style: "destructive", onPress: () => void run(() => patchAdminShopAccountStatus(shopId, "suspended")) },
                      ])
                    }
                  >
                    <Text style={styles.actionText}>Suspend</Text>
                  </Pressable>
                  <Pressable style={styles.actionBtn} disabled={busy} onPress={() => void run(() => patchAdminShopAccountStatus(shopId, "active"))}>
                    <Text style={styles.actionText}>Reactivate</Text>
                  </Pressable>
                </View>
              </ProfileCard>
            ) : null}

            <ProfileCard style={styles.section}>
              <Text style={styles.sectionTitle}>Barbers ({detail.barbers?.length || 0})</Text>
              {!detail.barbers?.length ? (
                <Text style={styles.meta}>No barbers assigned.</Text>
              ) : (
                detail.barbers.slice(0, 20).map((b) => (
                  <Text key={b.id} style={styles.meta}>
                    {b.name} · {b.email || "—"}
                  </Text>
                ))
              )}
            </ProfileCard>

            <ProfileCard style={styles.section}>
              <Text style={styles.sectionTitle}>Recent bookings ({detail.bookings?.length || 0})</Text>
              {!detail.bookings?.length ? (
                <Text style={styles.meta}>No bookings yet.</Text>
              ) : (
                detail.bookings.slice(0, 10).map((bk) => (
                  <Text key={bk.id} style={styles.meta}>
                    {bk.name} · {bk.service} · ${Number(bk.totalPrice || 0).toFixed(2)}
                  </Text>
                ))
              )}
            </ProfileCard>
          </>
        ) : null}
      </ScrollView>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: 12, paddingBottom: 24 },
  section: { marginTop: 4 },
  sectionTitle: { color: theme.colors.gold, fontWeight: "800", marginBottom: 8 },
  meta: { color: theme.colors.textMuted, fontSize: 13, marginBottom: 4, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  actionBtn: { backgroundColor: "rgba(245,200,66,0.15)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  rejectBtn: { backgroundColor: "rgba(248,113,113,0.2)" },
  actionText: { color: theme.colors.text, fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toggleLabel: { color: theme.colors.text, fontSize: 14 },
  toggleValue: { fontWeight: "800", fontSize: 12 },
  on: { color: "#86efac" },
  off: { color: "#fca5a5" },
  disabled: { opacity: 0.5 },
});
