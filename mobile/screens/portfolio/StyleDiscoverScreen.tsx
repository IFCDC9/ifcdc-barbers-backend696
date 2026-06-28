import React, { useCallback, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenLoading } from "../../components/LoadingState";
import { palette, radius, typography } from "../../constants/theme";
import {
  fetchDiscoverPhotos,
  fetchPortfolioCategories,
  type PortfolioCategory,
  type PortfolioPhoto,
} from "../../services/socialPortfolioApi";
import { getServiceCardImageUrl } from "../../utils/styleImageUrl";

export default function StyleDiscoverScreen() {
  const navigation = useNavigation<{ navigate: (name: string, params?: object) => void }>();
  const { width } = useWindowDimensions();
  const colCount = width >= 768 ? 4 : width >= 480 ? 3 : 2;
  const gap = 10;
  const tile = Math.floor((Math.min(width, 820) - 32 - gap * (colCount - 1)) / colCount);

  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<PortfolioCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState("");
  const [photos, setPhotos] = useState<PortfolioPhoto[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [cats, items] = await Promise.all([
        fetchPortfolioCategories().catch(() => []),
        fetchDiscoverPhotos(activeCategory || undefined),
      ]);
      setCategories(cats);
      setPhotos(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load discovery feed");
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [activeCategory]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <ProfileScreenLayout title="Discover" subtitle="Browse real client results by style">
      {loading ? <ScreenLoading /> : null}
      {!loading ? (
        <ScrollView contentContainerStyle={styles.scroll}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <GlowButton
              label="All styles"
              variant={!activeCategory ? "primary" : "outline"}
              onPress={() => setActiveCategory("")}
              style={styles.chipBtn}
            />
            {categories.map((cat) => (
              <GlowButton
                key={cat.id}
                label={cat.label}
                variant={activeCategory === cat.id ? "primary" : "outline"}
                onPress={() => setActiveCategory(cat.id)}
                style={styles.chipBtn}
              />
            ))}
          </ScrollView>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={[styles.grid, { gap }]}>
            {photos.map((photo) => (
              <Pressable
                key={photo.id}
                style={[styles.tile, { width: tile, height: tile }]}
                onPress={() => {
                  const slug = photo.barberSlug || photo.barberId;
                  if (slug) {
                    navigation.navigate("BarberPortfolio", {
                      slugOrId: String(slug),
                      barberName: photo.barberName,
                    });
                  }
                }}
              >
                <Image
                  source={{ uri: getServiceCardImageUrl(photo.thumbnailUrl || photo.photoUrl) }}
                  style={styles.image}
                  resizeMode="cover"
                />
                {photo.serviceName || photo.barberName ? (
                  <Text style={styles.caption} numberOfLines={2}>
                    {photo.serviceName || photo.caption || photo.barberName}
                    {photo.price != null ? ` · $${Number(photo.price).toFixed(0)}` : ""}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
          {!photos.length && !error ? (
            <Text style={styles.empty}>No photos yet — check back as clients share their cuts.</Text>
          ) : null}
        </ScrollView>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32, gap: 12 },
  chips: { gap: 8, paddingVertical: 4 },
  chipBtn: { marginRight: 0 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  tile: {
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: palette.bg2,
    borderWidth: 1,
    borderColor: palette.border,
  },
  image: { width: "100%", height: "100%" },
  caption: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    ...typography.caption,
    fontSize: 10,
    color: palette.gold,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  empty: { ...typography.bodyMuted, textAlign: "center", paddingVertical: 24 },
  error: { color: "#f87171", ...typography.bodyMuted },
});
