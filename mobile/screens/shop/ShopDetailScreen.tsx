import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import ShopStaffGuard from "../../components/ShopStaffGuard";
import { fetchShopDetail, type ShopRow } from "../../services/shopStaffApi";
import { theme } from "../../constants/theme";
import ShareButton from "../../components/ShareButton";
import {
  APP_BRAND_NAME,
  buildShopShareMessage,
} from "../../utils/shareContent";

export type ShopDetailParams = {
  businessId: string;
  shopName: string;
  isPlaceholder?: boolean;
};

type DetailRoute = RouteProp<{ ShopDetail: ShopDetailParams }, "ShopDetail">;

type NavParams = {
  ShopEdit: ShopDetailParams;
  AdminBarbers: undefined;
  BarberRoster: undefined;
  AdminBookings: undefined;
  AdminPayout: undefined;
  AdminSchedule: undefined;
  ScheduleControls: undefined;
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

function ShopDetailInner() {
  const navigation = useNavigation<StackNavigationProp<NavParams>>();
  const route = useRoute<DetailRoute>();
  const { businessId, shopName } = route.params;

  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState<ShopRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setShop(await fetchShopDetail(businessId));
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const displayName = shop?.name || shopName;
  const routeNames = (navigation.getState() as any)?.routeNames as string[] | undefined;

  const formatStatus = (status?: string | null) => {
    const raw = String(status || "active").trim().toLowerCase();
    if (!raw || raw === "coming_soon") return "Active";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  };

  const go = (screen: keyof NavParams, params?: object) => {
    if (routeNames?.includes(String(screen))) {
      navigation.navigate(screen as any, params as any);
    } else {
      Alert.alert("Admin tools", "Open the Admin tab to access this management area.");
    }
  };

  return (
    <ProfileScreenLayout title={displayName} subtitle="Business management">
      {loading ? <ActivityIndicator color={theme.colors.gold} style={{ marginTop: 24 }} /> : null}

      {!loading ? (
        <>
          <Section title="Overview">
            <Meta label="Shop name" value={displayName} />
            <Meta label="Business ID" value={businessId} />
            <Meta label="Owner" value={shop?.owner_name || "—"} />
            <Meta label="Status" value={formatStatus(shop?.status)} />
            <Meta label="Plan" value={shop?.plan || "Standard"} />
            {shop?.phone ? <Meta label="Phone" value={shop.phone} /> : null}
            <View style={styles.shareRow}>
              <ShareButton
                title={`${displayName} · ${APP_BRAND_NAME}`}
                message={buildShopShareMessage({
                  shopName: displayName,
                })}
                label="Share shop"
              />
            </View>
            {shop?.phone ? (
              <View style={{ marginTop: 12 }}>
                <GlowButton
                  label={`☎️ Call ${displayName}`}
                  variant="outline"
                  onPress={() => {
                    const digits = String(shop.phone).replace(/\D/g, "");
                    const e164 =
                      digits.length === 10
                        ? `+1${digits}`
                        : digits.length === 11 && digits.startsWith("1")
                          ? `+${digits}`
                          : String(shop.phone).startsWith("+")
                            ? String(shop.phone)
                            : `+${digits}`;
                    void Linking.openURL(`tel:${e164}`);
                  }}
                />
              </View>
            ) : (
              <View style={{ marginTop: 12 }}>
                <GlowButton
                  label="☎️ Call IFCDC Barbers App"
                  variant="outline"
                  onPress={() => void Linking.openURL("tel:+19895141064")}
                />
              </View>
            )}
          </Section>

          <Section title="Metrics">
            <Meta label="Barbers" value={String(shop?.barber_count ?? 0)} />
            <Meta label="Bookings" value={String(shop?.booking_count ?? 0)} />
          </Section>

          <Section title="Operations">
            <Text style={styles.body}>
              Manage barbers, schedules, bookings, and revenue for this business location.
            </Text>
          </Section>

          <View style={styles.actions}>
            <GlowButton
              label="Edit Shop"
              variant="outline"
              onPress={() => navigation.navigate("ShopEdit", { businessId, shopName: displayName })}
            />
            <View style={{ height: 10 }} />
            <GlowButton label="Manage Barbers" variant="outline" onPress={() => go("AdminBarbers")} />
            <View style={{ height: 10 }} />
            <GlowButton label="View Bookings" variant="outline" onPress={() => go("AdminBookings")} />
            <View style={{ height: 10 }} />
            <GlowButton label="Revenue / payouts" variant="outline" onPress={() => go("AdminPayout")} />
            <View style={{ height: 10 }} />
            <GlowButton
              label="Schedule controls"
              variant="outline"
              onPress={() => go(routeNames.includes("AdminSchedule") ? "AdminSchedule" : "ScheduleControls")}
            />
          </View>
        </>
      ) : null}
    </ProfileScreenLayout>
  );
}

export default function ShopDetailScreen() {
  return (
    <ShopStaffGuard>
      <ShopDetailInner />
    </ShopStaffGuard>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  sectionTitle: { color: theme.colors.gold, fontSize: 15, fontWeight: "800", marginBottom: 4 },
  metaRow: { gap: 2 },
  metaLabel: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "600", textTransform: "uppercase" },
  metaValue: { color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  body: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
  actions: { marginTop: 8 },
  shareRow: { marginTop: 8 },
});
