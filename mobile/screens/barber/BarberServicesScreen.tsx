import React, { useCallback, useEffect, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import ServiceManagementGuard from "../../components/ServiceManagementGuard";
import { ScreenEmpty, ScreenLoading } from "../../components/LoadingState";
import {
  archiveBarberService,
  deleteBarberService,
  fetchBarberServices,
  updateBarberService,
  type BarberServiceRow,
} from "../../services/barberStaffApi";
import { apiFullUrl } from "../../constants/config";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { confirmDelete } from "../../utils/confirmDelete";
import { theme } from "../../constants/theme";
import ShareButton from "../../components/ShareButton";
import {
  APP_BRAND_NAME,
  buildServiceShareMessage,
} from "../../utils/shareContent";
import type { BarberDetailParams } from "./BarberDetailScreen";

export type EditServiceParams = BarberDetailParams & {
  serviceId?: string;
};

type ServicesRoute = RouteProp<{ BarberServices: BarberDetailParams }, "BarberServices">;

type Nav = {
  EditService: EditServiceParams;
};

function serviceImageUri(url?: string | null): string | null {
  if (!url) return null;
  return url.startsWith("http") ? url : apiFullUrl(url);
}

function ServiceRow({
  service,
  barberName,
  onEdit,
  onToggle,
  onArchive,
  onDelete,
}: {
  service: BarberServiceRow;
  barberName: string;
  onEdit: () => void;
  onToggle: (active: boolean) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const img = serviceImageUri(service.image_url);
  const active = service.is_active !== false;

  return (
    <ProfileCard style={styles.row}>
      <Pressable onPress={onEdit} style={styles.rowMain}>
        <View style={styles.thumbWrap}>
          {img ? (
            <Image source={{ uri: img }} style={styles.thumb} />
          ) : (
            <Text style={styles.thumbIcon}>{service.icon || "✂️"}</Text>
          )}
        </View>
        <View style={styles.copy}>
          <Text style={styles.name}>{service.name || "Service"}</Text>
          {service.category ? <Text style={styles.category}>{service.category}</Text> : null}
          {service.description ? (
            <Text style={styles.description} numberOfLines={2}>
              {service.description}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            ${Number(service.price || 0).toFixed(2)} · {service.duration_minutes || 30} min
          </Text>
          {!active ? <Text style={styles.inactive}>Archived / inactive</Text> : null}
        </View>
      </Pressable>
      <View style={styles.rowActions}>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Active</Text>
          <Switch
            value={active}
            onValueChange={onToggle}
            trackColor={{ false: "#333", true: "rgba(245,200,66,0.45)" }}
            thumbColor={active ? theme.colors.gold : "#888"}
          />
        </View>
        <View style={styles.actionBtns}>
          <Pressable onPress={onEdit} style={styles.linkBtn}>
            <Text style={styles.linkText}>Edit</Text>
          </Pressable>
          {active ? (
            <Pressable onPress={onArchive} style={styles.linkBtn}>
              <Text style={styles.linkText}>Archive</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onDelete} style={styles.linkBtn}>
            <Text style={styles.dangerText}>Delete</Text>
          </Pressable>
        </View>
        <ShareButton
          style={styles.shareBtn}
          label="Share service"
          title={`${service.name || "Service"} · ${APP_BRAND_NAME}`}
          message={buildServiceShareMessage({
            serviceName: service.name || "Service",
            barberName,
            price: service.price,
            durationMinutes: service.duration_minutes,
            description: service.description,
          })}
        />
      </View>
    </ProfileCard>
  );
}

function BarberServicesInner() {
  const navigation = useNavigation<StackNavigationProp<Nav>>();
  const route = useRoute<ServicesRoute>();
  const { barberId, barberName } = route.params;

  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<BarberServiceRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setServices(await fetchBarberServices(barberId, { includeInactive: true }));
    } finally {
      setLoading(false);
    }
  }, [barberId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDeleteService = (service: BarberServiceRow) => {
    void (async () => {
      if (!(await confirmDelete(`Remove "${service.name}" from your menu?`))) return;
      try {
        await deleteBarberService(barberId, service.id);
        await load();
      } catch (e) {
        Alert.alert("Delete failed", userFacingApiError(e));
      }
    })();
  };

  const confirmArchive = (service: BarberServiceRow) => {
    Alert.alert("Archive service?", `"${service.name}" will be hidden from booking.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        onPress: async () => {
          try {
            await archiveBarberService(barberId, service.id);
            await load();
          } catch (e) {
            Alert.alert("Archive failed", userFacingApiError(e));
          }
        },
      },
    ]);
  };

  const toggleActive = async (service: BarberServiceRow, active: boolean) => {
    try {
      await updateBarberService(barberId, service.id, { is_active: active });
      await load();
    } catch (e) {
      Alert.alert("Update failed", userFacingApiError(e));
    }
  };

  const activeCount = services.filter((s) => s.is_active !== false).length;
  const subtitle = loading
    ? barberName
    : `${barberName} · ${activeCount} active · ${services.length} total`;

  return (
    <ProfileScreenLayout title="Service Management" subtitle={subtitle}>
      {loading ? <ScreenLoading /> : null}
      {!loading && services.length === 0 ? (
        <ScreenEmpty message="No services yet. Add your first menu item to make it bookable." />
      ) : null}
      {!loading
        ? services.map((s) => (
            <ServiceRow
              key={String(s.id)}
              service={s}
              barberName={barberName}
              onEdit={() =>
                navigation.navigate("EditService", {
                  barberId,
                  barberName,
                  serviceId: String(s.id),
                })
              }
              onToggle={(active) => void toggleActive(s, active)}
              onArchive={() => confirmArchive(s)}
              onDelete={() => onDeleteService(s)}
            />
          ))
        : null}
      <GlowButton
        label="Add Service"
        onPress={() => navigation.navigate("EditService", { barberId, barberName })}
      />
      <View style={{ height: 10 }} />
      <GlowButton label="Refresh" variant="outline" onPress={load} disabled={loading} />
    </ProfileScreenLayout>
  );
}

export default function BarberServicesScreen() {
  return (
    <ServiceManagementGuard>
      <BarberServicesInner />
    </ServiceManagementGuard>
  );
}

const styles = StyleSheet.create({
  row: { gap: 10, marginBottom: 10 },
  rowMain: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  thumbWrap: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumb: { width: 52, height: 52, resizeMode: "cover" },
  thumbIcon: { fontSize: 24 },
  copy: { flex: 1, gap: 3 },
  name: { color: theme.colors.text, fontSize: 16, fontWeight: "700" },
  category: { color: theme.colors.gold, fontSize: 12, fontWeight: "600", textTransform: "uppercase" },
  description: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 18 },
  meta: { color: theme.colors.gold, fontSize: 14, fontWeight: "700" },
  inactive: { color: "#f87171", fontSize: 12, fontWeight: "600" },
  rowActions: { gap: 8, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 8 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggleLabel: { color: theme.colors.textMuted, fontSize: 13, fontWeight: "600" },
  actionBtns: { flexDirection: "row", gap: 16 },
  linkBtn: { paddingVertical: 4 },
  linkText: { color: theme.colors.gold, fontSize: 14, fontWeight: "700" },
  dangerText: { color: "#f87171", fontSize: 14, fontWeight: "700" },
  shareBtn: { marginTop: 4, alignSelf: "flex-start" },
});
