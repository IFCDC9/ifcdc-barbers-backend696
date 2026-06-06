import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import ServiceManagementGuard from "../../components/ServiceManagementGuard";
import { ScreenLoading } from "../../components/LoadingState";
import {
  createBarberService,
  deleteBarberService,
  fetchBarberServices,
  updateBarberService,
  uploadBarberServiceImage,
} from "../../services/barberStaffApi";
import { confirmDelete } from "../../utils/confirmDelete";
import { apiFullUrl } from "../../constants/config";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";
import type { EditServiceParams } from "./BarberServicesScreen";

const CATEGORIES = ["Haircut", "Fade", "Beard", "Combo", "Kids", "Line Up", "Other"];

type EditRoute = RouteProp<{ EditService: EditServiceParams }, "EditService">;

function EditServiceInner() {
  const navigation = useNavigation();
  const route = useRoute<EditRoute>();
  const { barberId, barberName, serviceId } = route.params;
  const isEdit = Boolean(serviceId);

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Haircut");
  const [icon, setIcon] = useState("✂️");
  const [imageUrl, setImageUrl] = useState("");
  const [price, setPrice] = useState("25");
  const [duration, setDuration] = useState("30");
  const [isActive, setIsActive] = useState(true);

  const load = useCallback(async () => {
    if (!serviceId) return;
    setLoading(true);
    try {
      const list = await fetchBarberServices(barberId, { includeInactive: true });
      const row = list.find((s) => String(s.id) === String(serviceId));
      if (row) {
        setName(row.name || "");
        setDescription(row.description || "");
        setCategory(row.category || "Haircut");
        setIcon(row.icon || "✂️");
        setImageUrl(row.image_url || "");
        setPrice(String(row.price ?? 25));
        setDuration(String(row.duration_minutes ?? 30));
        setIsActive(row.is_active !== false);
      }
    } finally {
      setLoading(false);
    }
  }, [barberId, serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Allow photo access to upload a service image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setUploading(true);
    try {
      const url = await uploadBarberServiceImage(barberId, result.assets[0].uri);
      setImageUrl(url);
    } catch (e) {
      Alert.alert("Upload failed", userFacingApiError(e));
    } finally {
      setUploading(false);
    }
  };

  const onDelete = () => {
    if (!serviceId) return;
    void (async () => {
      if (!(await confirmDelete(`Remove "${name.trim() || "this service"}" from your menu?`))) return;
      setSaving(true);
      try {
        await deleteBarberService(barberId, serviceId);
        Alert.alert("Deleted", "Service removed.", [{ text: "OK", onPress: () => navigation.goBack() }]);
      } catch (e) {
        Alert.alert("Delete failed", userFacingApiError(e));
      } finally {
        setSaving(false);
      }
    })();
  };

  const onSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Name required", "Enter a service name.");
      return;
    }
    const priceNum = Number(price);
    const durationNum = Number(duration);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      Alert.alert("Invalid price", "Enter a valid price.");
      return;
    }
    if (!Number.isFinite(durationNum) || durationNum < 5) {
      Alert.alert("Invalid duration", "Duration must be at least 5 minutes.");
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: trimmed,
        description: description.trim(),
        category,
        icon: icon.trim() || "✂️",
        image_url: imageUrl.trim() || undefined,
        price: priceNum,
        duration_minutes: Math.round(durationNum),
        is_active: isActive,
      };
      if (isEdit && serviceId) {
        await updateBarberService(barberId, serviceId, body);
      } else {
        await createBarberService(barberId, body);
      }
      Alert.alert("Saved", "Service menu updated.", [{ text: "OK", onPress: () => navigation.goBack() }]);
    } catch (e) {
      Alert.alert("Save failed", userFacingApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const previewUri = imageUrl ? (imageUrl.startsWith("http") ? imageUrl : apiFullUrl(imageUrl)) : null;

  return (
    <ProfileScreenLayout title={isEdit ? "Edit Service" : "Add Service"} subtitle={barberName}>
      {loading ? <ScreenLoading /> : null}
      {!loading ? (
        <ScrollView showsVerticalScrollIndicator={false}>
          <ProfileCard style={styles.form}>
            <Pressable onPress={pickImage} style={styles.imagePicker}>
              {previewUri ? (
                <Image source={{ uri: previewUri }} style={styles.preview} />
              ) : (
                <Text style={styles.previewPlaceholder}>{icon || "📷"}</Text>
              )}
              <Text style={styles.uploadHint}>{uploading ? "Uploading…" : "Tap to upload image"}</Text>
            </Pressable>

            <Text style={styles.label}>Name</Text>
            <TextInput value={name} onChangeText={setName} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />

            <Text style={styles.label}>Description</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              style={[styles.input, styles.multiline]}
              multiline
              placeholderTextColor="rgba(255,255,255,0.35)"
            />

            <Text style={styles.label}>Category</Text>
            <View style={styles.chips}>
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setCategory(c)}
                  style={[styles.chip, category === c && styles.chipActive]}
                >
                  <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{c}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>Icon (emoji)</Text>
            <TextInput value={icon} onChangeText={setIcon} style={styles.input} maxLength={4} placeholderTextColor="rgba(255,255,255,0.35)" />

            <Text style={styles.label}>Price (USD)</Text>
            <TextInput
              value={price}
              onChangeText={setPrice}
              style={styles.input}
              keyboardType="decimal-pad"
              placeholderTextColor="rgba(255,255,255,0.35)"
            />

            <Text style={styles.label}>Duration (minutes)</Text>
            <TextInput
              value={duration}
              onChangeText={setDuration}
              style={styles.input}
              keyboardType="number-pad"
              placeholderTextColor="rgba(255,255,255,0.35)"
            />

            <View style={styles.toggleRow}>
              <Text style={styles.label}>Active (visible in booking)</Text>
              <Switch
                value={isActive}
                onValueChange={setIsActive}
                trackColor={{ false: "#333", true: "rgba(245,200,66,0.45)" }}
                thumbColor={isActive ? theme.colors.gold : "#888"}
              />
            </View>

            <Text style={styles.assigned}>Assigned barber: {barberName}</Text>
          </ProfileCard>

          <GlowButton
            label={saving ? "Saving…" : isEdit ? "Save Changes" : "Create Service"}
            onPress={onSave}
            disabled={saving || uploading}
            loading={saving}
          />
          {isEdit ? (
            <GlowButton
              label="Delete service"
              variant="danger"
              onPress={onDelete}
              disabled={saving || uploading}
            />
          ) : null}
        </ScrollView>
      ) : null}
    </ProfileScreenLayout>
  );
}

export default function EditServiceScreen() {
  return (
    <ServiceManagementGuard>
      <EditServiceInner />
    </ServiceManagementGuard>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8, marginBottom: 16 },
  label: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "600", marginTop: 4 },
  input: {
    color: theme.colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
  },
  chipActive: { backgroundColor: "rgba(245,200,66,0.15)", borderColor: theme.colors.gold },
  chipText: { color: theme.colors.textMuted, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: theme.colors.gold },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  imagePicker: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
    borderRadius: theme.radius.sm,
    backgroundColor: "rgba(255,255,255,0.03)",
    marginBottom: 8,
  },
  preview: { width: 96, height: 96, borderRadius: 12, resizeMode: "cover" as const },
  previewPlaceholder: { fontSize: 40 },
  uploadHint: { color: theme.colors.gold, fontSize: 13, fontWeight: "600" },
  assigned: { color: theme.colors.textMuted, fontSize: 12, marginTop: 8 },
});
