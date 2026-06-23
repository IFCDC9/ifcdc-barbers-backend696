import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { ScreenLoading, ScreenEmpty, ScreenError } from "../../components/LoadingState";
import { theme } from "../../constants/theme";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { useAuth } from "../../services/authContext";
import {
  fetchAdminBarbers,
  patchBarberAccountStatus,
  patchBarberVerification,
  type AdminBarberFilters,
  type AdminBarberRow,
} from "../../services/adminBarbersApi";
import type { AdminStackParamList } from "../../navigation/AdminStack";

type Nav = StackNavigationProp<AdminStackParamList, "AdminGlobalBarbers">;

function StatusPill({ label, tone }: { label: string; tone: "gold" | "green" | "red" | "muted" }) {
  const bg =
    tone === "green"
      ? "rgba(34,197,94,0.18)"
      : tone === "red"
        ? "rgba(248,113,113,0.18)"
        : tone === "gold"
          ? "rgba(245,200,66,0.18)"
          : "rgba(148,163,184,0.15)";
  const color =
    tone === "green" ? "#86efac" : tone === "red" ? "#fca5a5" : tone === "gold" ? theme.colors.gold : theme.colors.textMuted;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function toneForStatus(status: string): "gold" | "green" | "red" | "muted" {
  const s = status.toLowerCase();
  if (s.includes("approved") || s.includes("active") || s.includes("pro") || s.includes("elite")) return "green";
  if (s.includes("pending")) return "gold";
  if (s.includes("suspend") || s.includes("inactive") || s.includes("reject")) return "red";
  return "muted";
}

export default function AdminGlobalBarbersScreen() {
  const navigation = useNavigation<Nav>();
  const { isPlatformAdmin } = useAuth();
  const [rows, setRows] = useState<AdminBarberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shop, setShop] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [activeFilter, setActiveFilter] = useState<"" | "active" | "inactive">("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [sort, setSort] = useState<AdminBarberFilters["sort"]>("newest");

  const filters = useMemo<AdminBarberFilters>(
    () => ({
      shop: shop.trim() || undefined,
      city: city.trim() || undefined,
      state: state.trim() || undefined,
      active: activeFilter || undefined,
      pendingApproval: pendingOnly,
      sort,
    }),
    [shop, city, state, activeFilter, pendingOnly, sort],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchAdminBarbers(filters));
    } catch (e) {
      setError(userFacingApiError(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const approveBarber = async (row: AdminBarberRow) => {
    try {
      await patchBarberVerification(row.barberId, "approved");
      await patchBarberAccountStatus(row.barberId, "approved");
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    }
  };

  const suspendBarber = async (row: AdminBarberRow) => {
    try {
      await patchBarberAccountStatus(row.barberId, "suspended");
      await load();
    } catch (e) {
      setError(userFacingApiError(e));
    }
  };

  return (
    <ProfileScreenLayout
      title="Barber management"
      subtitle={isPlatformAdmin ? "Global platform view" : "Your shop barbers"}
    >
      <ProfileCard>
        <Text style={styles.filterLabel}>Filters</Text>
        <TextInput style={styles.input} placeholder="Shop name" value={shop} onChangeText={setShop} placeholderTextColor={theme.colors.textMuted} />
        <View style={styles.row}>
          <TextInput style={[styles.input, styles.half]} placeholder="City" value={city} onChangeText={setCity} placeholderTextColor={theme.colors.textMuted} />
          <TextInput style={[styles.input, styles.half]} placeholder="State" value={state} onChangeText={setState} placeholderTextColor={theme.colors.textMuted} />
        </View>
        <View style={styles.chips}>
          {(["", "active", "inactive"] as const).map((v) => (
            <Pressable key={v || "all"} style={[styles.chip, activeFilter === v && styles.chipActive]} onPress={() => setActiveFilter(v)}>
              <Text style={styles.chipText}>{v ? v : "All"}</Text>
            </Pressable>
          ))}
          <Pressable style={[styles.chip, pendingOnly && styles.chipActive]} onPress={() => setPendingOnly((p) => !p)}>
            <Text style={styles.chipText}>Pending approval</Text>
          </Pressable>
        </View>
        <View style={styles.chips}>
          {(["newest", "oldest", "name", "shop"] as const).map((v) => (
            <Pressable key={v} style={[styles.chip, sort === v && styles.chipActive]} onPress={() => setSort(v)}>
              <Text style={styles.chipText}>{v}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.applyBtn} onPress={() => void load()}>
          <Text style={styles.applyBtnText}>Apply filters</Text>
        </Pressable>
      </ProfileCard>

      {loading ? <ScreenLoading /> : null}
      {error ? <ScreenError message={error} /> : null}
      {!loading && !error && rows.length === 0 ? (
        <ScreenEmpty
          message={
            shop.trim() || city.trim() || state.trim() || activeFilter || pendingOnly
              ? "No barbers match these filters."
              : "No barbers found."
          }
        />
      ) : null}

      {rows.map((row) => (
        <Pressable
          key={row.id}
          onPress={() => navigation.navigate("BarberDetail", { barberId: row.id, barberName: row.fullName })}
        >
          <ProfileCard style={styles.card}>
            <Text style={styles.name}>{row.fullName}</Text>
            <Text style={styles.meta}>{row.shopName}</Text>
            <Text style={styles.meta}>{row.locationLabel}</Text>
            <Text style={styles.meta}>{row.email}{row.phone ? ` · ${row.phone}` : ""}</Text>
            <Text style={styles.meta}>
              Registered {row.registrationDate ? new Date(row.registrationDate).toLocaleDateString() : "—"}
            </Text>
            <View style={styles.pillRow}>
              <StatusPill label={row.accountStatus} tone={toneForStatus(row.accountStatus)} />
              <StatusPill label={row.subscriptionStatus} tone={toneForStatus(row.subscriptionStatus)} />
              <StatusPill label={row.verificationStatus} tone={toneForStatus(row.verificationStatus)} />
            </View>
            {isPlatformAdmin && row.pendingApproval ? (
              <View style={styles.actions}>
                <Pressable style={styles.approveBtn} onPress={() => void approveBarber(row)}>
                  <Text style={styles.actionText}>Approve</Text>
                </Pressable>
                <Pressable style={styles.suspendBtn} onPress={() => void suspendBarber(row)}>
                  <Text style={styles.actionText}>Suspend</Text>
                </Pressable>
              </View>
            ) : null}
          </ProfileCard>
        </Pressable>
      ))}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  filterLabel: { color: theme.colors.gold, fontWeight: "800", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.text,
    marginBottom: 8,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  half: { flex: 1 },
  row: { flexDirection: "row", gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipActive: { borderColor: theme.colors.gold, backgroundColor: "rgba(245,200,66,0.12)" },
  chipText: { color: theme.colors.text, fontSize: 12, fontWeight: "700" },
  applyBtn: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.gold,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  applyBtnText: { color: "#111", fontWeight: "800" },
  card: { marginTop: 12 },
  name: { color: theme.colors.text, fontSize: 17, fontWeight: "800" },
  meta: { color: theme.colors.textMuted, fontSize: 13, marginTop: 4 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 11, fontWeight: "800" },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  approveBtn: { backgroundColor: "rgba(34,197,94,0.25)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  suspendBtn: { backgroundColor: "rgba(248,113,113,0.25)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  actionText: { color: theme.colors.text, fontWeight: "700", fontSize: 12 },
});
