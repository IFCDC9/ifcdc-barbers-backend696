import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { palette, typography } from "../../constants/theme";
import {
  APPLE_PRODUCT_IDS,
  APPLE_SUBSCRIPTION_GROUP,
  GOOGLE_ACCESS_PRODUCT_ID,
  LIST_PRICE_USD,
  PLAN_RANK,
  displayPrice,
  fetchEntitlementsMe,
  fetchStoreProducts,
  introEligibilityFromProduct,
  purchaseProduct,
  purchaseWithPromoOffer,
  restorePurchases,
} from "../../services/storeBilling";
import { Platform } from "react-native";

const PLAN_COPY: Record<string, { name: string; blurb: string }> = {
  "ifcdc.barbers.individual.monthly": {
    name: "Individual",
    blurb: "Solo barber tools. Role is not a plan — this is a paid subscription.",
  },
  "ifcdc.barbers.shop.monthly": {
    name: "Shop",
    blurb: "One shop. Staff inherit shop access by permission, not by job title.",
  },
  "ifcdc.barbers.multilocation.monthly": {
    name: "Multi-Location",
    blurb: "Highest rank in IFCDC Barbers Pro Plans. Inherits to assigned staff.",
  },
};

export default function SubscriptionScreen() {
  const route = useRoute();
  const shopScoped = String(route.name || "").includes("Shop");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [native, setNative] = useState(false);
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [entitlements, setEntitlements] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [store, me] = await Promise.all([
        fetchStoreProducts(),
        fetchEntitlementsMe().catch(() => null),
      ]);
      setNative(store.native);
      setProducts(store.products || []);
      if (store.error) setNotice(store.error);
      const payload = me as { entitlements?: Record<string, unknown> } | null;
      setEntitlements(payload?.entitlements || (me as Record<string, unknown>) || null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not load plans");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentProductId = useMemo(() => {
    const plan = String(entitlements?.planKey || "");
    if (plan === "multilocation") return "ifcdc.barbers.multilocation.monthly";
    if (plan === "shop") return "ifcdc.barbers.shop.monthly";
    if (plan === "individual") return "ifcdc.barbers.individual.monthly";
    return "";
  }, [entitlements]);

  const onBuy = async (productId: string) => {
    setBusy(productId);
    try {
      const result = await purchaseProduct(productId, { upgradeFrom: currentProductId || undefined });
      if (result.error === "user_cancelled") {
        return;
      }
      if (result.error === "pending") {
        Alert.alert("Purchase pending", result.message || "The store has not finished this transaction yet.");
        return;
      }
      if (!result.ok) {
        Alert.alert("Purchase", result.message || result.error || "Purchase could not be verified.");
        return;
      }
      await refresh();
      Alert.alert("Verified", "Your plan was confirmed by the server — not by the app screen.");
    } catch (e) {
      Alert.alert("Purchase", e instanceof Error ? e.message : "Purchase failed.");
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    setBusy("restore");
    try {
      await restorePurchases();
      await refresh();
      Alert.alert("Restore", "Restored purchases were sent to the server for verification.");
    } catch (e) {
      Alert.alert("Restore", e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  };

  const onPromo = async (productId: string) => {
    const result = await purchaseWithPromoOffer(productId, null);
    Alert.alert(
      "Promotional offer",
      result.message || "No promotional offer is available for this Apple ID right now.",
    );
  };

  const ids = Platform.OS === "ios" ? APPLE_PRODUCT_IDS : [...APPLE_PRODUCT_IDS];
  const ordered = [...ids].sort((a, b) => (PLAN_RANK[b] || 0) - (PLAN_RANK[a] || 0));

  return (
    <ProfileScreenLayout
      title={shopScoped ? "Shop subscription" : "IFCDC Pro"}
      subtitle={shopScoped ? "Shop & multi-location plans" : "Subscriptions verified on the server"}
    >
      <ProfileCard glow>
        <Text style={styles.kicker}>{APPLE_SUBSCRIPTION_GROUP}</Text>
        <Text style={styles.hero}>Black-and-gold plans. App access, SaaS, and the $0.99 booking fee stay separate.</Text>
        <Text style={styles.meta}>
          Status: {String(entitlements?.subscriptionStatus || "none")} · Plan: {String(entitlements?.planKey || "none")}
        </Text>
        <Text style={styles.meta}>
          Booking fee ${String((entitlements as { bookingPlatformFeeUsd?: number } | null)?.bookingPlatformFeeUsd ?? 0.99)}
        </Text>
        {!native ? <Text style={styles.warn}>{notice || "Store prices load live from Apple or Google on a store build."}</Text> : null}
      </ProfileCard>

      {loading ? (
        <ActivityIndicator color={palette.gold} style={{ marginVertical: 24 }} />
      ) : (
        ordered.map((id) => {
          const storeProduct = products.find((p) => String(p.productId || p.id) === id) || { productId: id };
          const copy = PLAN_COPY[id];
          const intro = introEligibilityFromProduct(storeProduct);
          const current = currentProductId === id;
          const rankHint =
            currentProductId && (PLAN_RANK[id] || 0) > (PLAN_RANK[currentProductId] || 0)
              ? "Upgrade"
              : currentProductId && (PLAN_RANK[id] || 0) < (PLAN_RANK[currentProductId] || 0)
                ? "Downgrade at period end"
                : "Subscribe";
          return (
            <ProfileCard key={id} glow={current}>
              <Text style={styles.planName}>{copy?.name}</Text>
              <Text style={styles.price}>{displayPrice(storeProduct)}</Text>
              <Text style={styles.blurb}>{copy?.blurb}</Text>
              <Text style={styles.intro}>
                Intro:{" "}
                {intro.eligible == null
                  ? "Checking eligibility…"
                  : intro.eligible
                    ? intro.intro || "First month free"
                    : "Standard price"}
              </Text>
              <GlowButton
                label={busy === id ? "Working…" : current ? "Current plan" : rankHint}
                disabled={busy != null || current}
                onPress={() => void onBuy(id)}
              />
              <Pressable onPress={() => void onPromo(id)} hitSlop={8}>
                <Text style={styles.promo}>Promotional pricing may apply when Apple offers it for your account.</Text>
              </Pressable>
            </ProfileCard>
          );
        })
      )}

      {Platform.OS === "android" ? (
        <ProfileCard>
          <Text style={styles.planName}>Android app access</Text>
          <Text style={styles.price}>${LIST_PRICE_USD[GOOGLE_ACCESS_PRODUCT_ID].toFixed(2)}</Text>
          <Text style={styles.blurb}>
            One-time, non-consumable, restorable, account-bound. Separate from the booking fee.
          </Text>
          <GlowButton
            label={busy === GOOGLE_ACCESS_PRODUCT_ID ? "Working…" : "Unlock access"}
            disabled={busy != null}
            onPress={() => void onBuy(GOOGLE_ACCESS_PRODUCT_ID)}
          />
        </ProfileCard>
      ) : (
        <ProfileCard>
          <Text style={styles.planName}>App Store billing</Text>
          <Text style={styles.blurb}>
            Subscriptions are billed through the App Store. Restore purchases if you already subscribed with this Apple ID.
          </Text>
        </ProfileCard>
      )}

      <View style={{ gap: 12, marginBottom: 24 }}>
        <GlowButton label={busy === "restore" ? "Restoring…" : "Restore purchases"} variant="outline" onPress={() => void onRestore()} disabled={busy != null} />
      </View>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: palette.gold,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.6,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  hero: { color: palette.text, fontSize: 16, lineHeight: 22, marginBottom: 10, ...typography.body },
  meta: { color: palette.textMuted, fontSize: 13, marginBottom: 4 },
  warn: { color: palette.goldHigh, marginTop: 10, fontSize: 13, lineHeight: 18 },
  planName: { color: palette.gold, fontSize: 18, fontWeight: "800", marginBottom: 4 },
  price: { color: palette.text, fontSize: 28, fontWeight: "700", marginBottom: 8 },
  blurb: { color: palette.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 10 },
  intro: { color: palette.textDim, fontSize: 12, marginBottom: 12 },
  promo: { color: palette.gold, textAlign: "center", marginTop: 12, fontSize: 12 },
});
