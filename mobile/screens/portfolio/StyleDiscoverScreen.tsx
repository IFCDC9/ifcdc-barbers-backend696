import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import { palette, radius, typography } from "../../constants/theme";
import { useAuth } from "../../services/authContext";
import {
  deleteDiscoverPhoto,
  fetchDiscoverPhotos,
  fetchPortfolioCategories,
  hideDiscoverPhoto,
  patchDiscoverPhoto,
  replaceDiscoverPhotoImage,
  setDiscoverPhotoCover,
  type PortfolioCategory,
  type PortfolioPhoto,
} from "../../services/socialPortfolioApi";
import { getServiceCardImageUrl } from "../../utils/styleImageUrl";

const DISCOVER_LIMIT = 100;

function staffRoleCanEdit(role: string | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  const r = String(role || "").toLowerCase();
  return r === "super_admin" || r === "admin" || r === "shop_owner" || r === "barber";
}

export default function StyleDiscoverScreen() {
  const navigation = useNavigation<{ navigate: (name: string, params?: object) => void }>();
  const { user, isPlatformAdmin } = useAuth();
  const showStaffChrome = staffRoleCanEdit(user?.role, isPlatformAdmin);
  const { width } = useWindowDimensions();
  const colCount = width >= 768 ? 4 : width >= 480 ? 3 : 2;
  const gap = 10;
  const tile = Math.floor((Math.min(width, 820) - 48 - gap * (colCount - 1)) / colCount);
  const stripRef = useRef<ScrollView>(null);

  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [categories, setCategories] = useState<PortfolioCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState("");
  const [photos, setPhotos] = useState<PortfolioPhoto[]>([]);
  const [error, setError] = useState("");
  const [editPhoto, setEditPhoto] = useState<PortfolioPhoto | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCaption, setEditCaption] = useState("");
  const [editCategory, setEditCategory] = useState("");

  const load = useCallback(
    async (categoryId: string, mode: "initial" | "refresh" | "silent" = "initial") => {
      if (mode === "initial") setInitialLoading(true);
      if (mode === "refresh") setRefreshing(true);
      if (mode !== "silent") setError("");
      try {
        const [cats, items] = await Promise.all([
          fetchPortfolioCategories().catch(() => []),
          fetchDiscoverPhotos(categoryId || undefined, DISCOVER_LIMIT),
        ]);
        setCategories(cats);
        setPhotos(items);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load discovery feed");
        if (mode === "initial") setPhotos([]);
      } finally {
        setInitialLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      void load(activeCategory, photos.length ? "silent" : "initial");
    }, [activeCategory, load, photos.length]),
  );

  const onRefresh = useCallback(() => {
    void load(activeCategory, "refresh");
  }, [activeCategory, load]);

  const onSelectCategory = (categoryId: string) => {
    setActiveCategory(categoryId);
    void load(categoryId, "initial");
  };

  const captionFor = (photo: PortfolioPhoto) => {
    const name = photo.serviceName || photo.caption || photo.barberName || "";
    const price =
      photo.price != null && Number.isFinite(Number(photo.price))
        ? ` · $${Number(photo.price).toFixed(0)}`
        : "";
    return `${name}${price}`.trim();
  };

  const chips = useMemo(
    () => [{ id: "", label: "All Styles" }, ...categories],
    [categories],
  );

  const openMenu = (photo: PortfolioPhoto) => {
    const run = async (key: string) => {
      try {
        if (key === "edit") {
          setEditPhoto(photo);
          setEditTitle(photo.title || photo.caption || photo.serviceName || "");
          setEditCaption(photo.caption || "");
          setEditCategory(photo.styleCategory || "");
          return;
        }
        if (key === "replace") {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) {
            Alert.alert("Permission needed", "Allow photo library access to replace this image.");
            return;
          }
          const picked = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.85,
            allowsEditing: true,
            aspect: [1, 1],
          });
          if (picked.canceled || !picked.assets?.[0]?.uri) return;
          const asset = picked.assets[0];
          await replaceDiscoverPhotoImage(photo.id, {
            uri: asset.uri,
            name: asset.fileName || "photo.jpg",
            type: asset.mimeType || "image/jpeg",
          });
          await load(activeCategory, "refresh");
          return;
        }
        if (key === "category") {
          setEditPhoto(photo);
          setEditTitle(photo.title || photo.caption || "");
          setEditCaption(photo.caption || "");
          setEditCategory(photo.styleCategory || "");
          return;
        }
        if (key === "cover") {
          await setDiscoverPhotoCover(photo.id);
          await load(activeCategory, "refresh");
          return;
        }
        if (key === "hide") {
          await hideDiscoverPhoto(photo.id);
          await load(activeCategory, "refresh");
          return;
        }
        if (key === "delete") {
          Alert.alert("Delete photo", "Permanently delete this photo?", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => {
                void (async () => {
                  await deleteDiscoverPhoto(photo.id);
                  await load(activeCategory, "refresh");
                })();
              },
            },
          ]);
        }
      } catch (e) {
        Alert.alert("Error", e instanceof Error ? e.message : "Action failed");
      }
    };

    const options = [
      "Edit Photo",
      "Replace Photo",
      "Change Category",
      "Set as Cover",
      "Hide Photo",
      "Delete Photo",
      "Cancel",
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, destructiveButtonIndex: 5, cancelButtonIndex: 6 },
        (idx) => {
          const map = ["edit", "replace", "category", "cover", "hide", "delete"];
          if (idx == null || idx >= map.length) return;
          void run(map[idx]);
        },
      );
      return;
    }
    Alert.alert("Photo", undefined, [
      { text: "Edit Photo", onPress: () => void run("edit") },
      { text: "Replace Photo", onPress: () => void run("replace") },
      { text: "Change Category", onPress: () => void run("category") },
      { text: "Set as Cover", onPress: () => void run("cover") },
      { text: "Hide Photo", onPress: () => void run("hide") },
      { text: "Delete Photo", style: "destructive", onPress: () => void run("delete") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const saveEdit = async () => {
    if (!editPhoto) return;
    try {
      await patchDiscoverPhoto(editPhoto.id, {
        title: editTitle,
        caption: editCaption,
        styleCategory: editCategory || undefined,
      });
      setEditPhoto(null);
      await load(activeCategory, "refresh");
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <ProfileScreenLayout
      title="Discover"
      subtitle="Browse real client results by style"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={palette.gold}
          colors={[palette.gold]}
        />
      }
    >
      <ScrollView
        ref={stripRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={styles.chipsScroll}
      >
        {chips.map((cat) => {
          const selected = activeCategory === cat.id || (!activeCategory && cat.id === "");
          return (
            <Pressable
              key={cat.id || "all"}
              onPress={() => onSelectCategory(cat.id)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
                {cat.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {initialLoading && !photos.length ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={palette.gold} />
          <Text style={styles.loadingText}>Loading styles…</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!error ? (
        <Text style={styles.countLabel}>
          {photos.length} photo{photos.length === 1 ? "" : "s"}
          {activeCategory ? " in this style" : " — all styles"}
        </Text>
      ) : null}

      <View style={[styles.grid, { gap }]}>
        {photos.map((photo) => {
          const caption = captionFor(photo);
          const canEdit = showStaffChrome && photo.canEdit === true;
          return (
            <View key={photo.id} style={[styles.tile, { width: tile }]}>
              <Pressable
                style={{ height: tile }}
                onPress={() => {
                  const slug = photo.barberSlug || photo.barberId;
                  if (!slug) return;
                  navigation.navigate("BarberPortfolio", {
                    slugOrId: String(slug),
                    barberName: photo.barberName,
                  });
                }}
              >
                <View style={[styles.imageWrap, { height: tile }]}>
                  <Image
                    source={{ uri: getServiceCardImageUrl(photo.thumbnailUrl || photo.photoUrl) }}
                    style={styles.image}
                    resizeMode="cover"
                  />
                </View>
              </Pressable>
              {canEdit ? (
                <Pressable style={styles.menuBtn} onPress={() => openMenu(photo)} hitSlop={8}>
                  <Text style={styles.menuBtnText}>⋯</Text>
                </Pressable>
              ) : null}
              {caption ? (
                <Text style={styles.caption} numberOfLines={2}>
                  {caption}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {!initialLoading && !photos.length && !error ? (
        <Text style={styles.empty}>
          {activeCategory
            ? "No published photos in this style yet."
            : "No photos yet — pull down to refresh after uploading new styles."}
        </Text>
      ) : null}

      {editPhoto ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit photo</Text>
            <Text style={styles.modalLabel}>Title</Text>
            <TextInput
              value={editTitle}
              onChangeText={setEditTitle}
              style={styles.modalInput}
              placeholderTextColor="rgba(255,255,255,0.35)"
            />
            <Text style={styles.modalLabel}>Caption</Text>
            <TextInput
              value={editCaption}
              onChangeText={setEditCaption}
              style={[styles.modalInput, { minHeight: 72 }]}
              multiline
              placeholderTextColor="rgba(255,255,255,0.35)"
            />
            <Text style={styles.modalLabel}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {categories.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => setEditCategory(c.id)}
                  style={[styles.chip, editCategory === c.id && styles.chipSelected, { marginRight: 8 }]}
                >
                  <Text style={[styles.chipText, editCategory === c.id && styles.chipTextSelected]}>
                    {c.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable onPress={() => setEditPhoto(null)} style={styles.modalBtnGhost}>
                <Text style={styles.chipText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void saveEdit()} style={styles.modalBtn}>
                <Text style={styles.chipTextSelected}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  chipsScroll: { flexGrow: 0, marginHorizontal: -4, maxHeight: 52 },
  chips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  chip: {
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    backgroundColor: "transparent",
    justifyContent: "center",
  },
  chipSelected: {
    backgroundColor: palette.gold,
    borderColor: palette.gold,
  },
  chipText: {
    color: palette.gold,
    fontSize: 13,
    fontWeight: "700",
  },
  chipTextSelected: {
    color: "#111",
    fontWeight: "800",
  },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 24 },
  loadingText: { ...typography.bodyMuted },
  countLabel: { ...typography.caption, color: palette.gold, marginBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  tile: {
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: palette.bg2,
    borderWidth: 1,
    borderColor: palette.border,
    position: "relative",
  },
  imageWrap: { width: "100%", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  menuBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  menuBtnText: { color: "#fff", fontSize: 18, fontWeight: "800", marginTop: -2 },
  caption: {
    ...typography.caption,
    fontSize: 11,
    color: palette.gold,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 36,
  },
  empty: { ...typography.bodyMuted, textAlign: "center", paddingVertical: 24 },
  error: { color: "#f87171", ...typography.bodyMuted },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 20,
    zIndex: 20,
  },
  modalCard: {
    backgroundColor: "#111",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    padding: 16,
  },
  modalTitle: { color: palette.gold, fontSize: 18, fontWeight: "800", marginBottom: 12 },
  modalLabel: { color: "rgba(255,255,255,0.7)", fontSize: 12, marginBottom: 4 },
  modalInput: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 10,
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  modalBtn: {
    backgroundColor: palette.gold,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalBtnGhost: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
  },
});
