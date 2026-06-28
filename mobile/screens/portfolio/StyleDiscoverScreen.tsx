import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import GlowButton from "../../components/GlowButton";
import { palette, radius, typography } from "../../constants/theme";
import {
  fetchDiscoverPhotos,
  fetchPortfolioCategories,
  type PortfolioCategory,
  type PortfolioPhoto,
} from "../../services/socialPortfolioApi";
import { getServiceCardImageUrl } from "../../utils/styleImageUrl";

const DISCOVER_LIMIT = 100;

export default function StyleDiscoverScreen() {
  const navigation = useNavigation<{ navigate: (name: string, params?: object) => void }>();
  const { width } = useWindowDimensions();
  const colCount = width >= 768 ? 4 : width >= 480 ? 3 : 2;
  const gap = 10;
  const tile = Math.floor((Math.min(width, 820) - 48 - gap * (colCount - 1)) / colCount);

  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [categories, setCategories] = useState<PortfolioCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState("");
  const [photos, setPhotos] = useState<PortfolioPhoto[]>([]);
  const [error, setError] = useState("");

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
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={styles.chipsScroll}
      >
        <GlowButton
          label="All styles"
          variant={!activeCategory ? "primary" : "outline"}
          onPress={() => onSelectCategory("")}
          style={styles.chipBtn}
        />
        {categories.map((cat) => (
          <GlowButton
            key={cat.id}
            label={cat.label}
            variant={activeCategory === cat.id ? "primary" : "outline"}
            onPress={() => onSelectCategory(cat.id)}
            style={styles.chipBtn}
          />
        ))}
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
          return (
            <Pressable
              key={photo.id}
              style={[styles.tile, { width: tile, height: tile + (caption ? 36 : 0) }]}
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
              {caption ? (
                <Text style={styles.caption} numberOfLines={2}>
                  {caption}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {!initialLoading && !photos.length && !error ? (
        <Text style={styles.empty}>No photos yet — pull down to refresh after uploading new styles.</Text>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  chipsScroll: { flexGrow: 0, marginHorizontal: -4 },
  chips: { gap: 8, paddingVertical: 4, paddingHorizontal: 4 },
  chipBtn: { marginRight: 0 },
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
  },
  imageWrap: { width: "100%", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
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
});
