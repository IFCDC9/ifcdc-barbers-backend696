import React from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { palette, radius, typography } from "../constants/theme";
import type { PortfolioPhoto } from "../services/socialPortfolioApi";

type Props = {
  photos: PortfolioPhoto[];
  onPhotoPress?: (photo: PortfolioPhoto) => void;
  onPhotoLongPress?: (photo: PortfolioPhoto) => void;
  onLike?: (photo: PortfolioPhoto) => void;
  columns?: number;
};

export default function PortfolioPhotoGrid({ photos, onPhotoPress, onPhotoLongPress, onLike, columns }: Props) {
  const { width } = useWindowDimensions();
  const colCount = columns || (width >= 768 ? 4 : width >= 480 ? 3 : 2);
  const gap = 10;
  const tile = Math.floor((Math.min(width, 720) - 32 - gap * (colCount - 1)) / colCount);

  if (!photos.length) {
    return <Text style={styles.empty}>No photos yet — be the first to share your cut.</Text>;
  }

  return (
    <View style={[styles.grid, { gap }]}>
      {photos.map((photo) => (
        <Pressable
          key={photo.id}
          onPress={() => onPhotoPress?.(photo)}
          onLongPress={() => onPhotoLongPress?.(photo)}
          style={[styles.tile, { width: tile, height: tile }]}
        >
          <Image source={{ uri: photo.thumbnailUrl || photo.photoUrl }} style={styles.image} resizeMode="cover" />
          {photo.is30DayFollowup ? (
            <View style={styles.tag}>
              <Text style={styles.tagText}>30-day</Text>
            </View>
          ) : null}
          {photo.photoType === "before" ? (
            <View style={[styles.tag, styles.beforeTag]}>
              <Text style={styles.tagText}>Before</Text>
            </View>
          ) : null}
          {onLike ? (
            <Pressable style={styles.likeBtn} onPress={() => onLike(photo)} hitSlop={8}>
              <Text style={[styles.likeText, photo.likedByViewer && styles.likeActive]}>
                ♥ {photo.likeCount || 0}
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap" },
  tile: {
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: palette.bg2,
    borderWidth: 1,
    borderColor: palette.border,
  },
  image: { width: "100%", height: "100%" },
  tag: {
    position: "absolute",
    top: 6,
    left: 6,
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
  },
  beforeTag: { left: undefined, right: 6 },
  tagText: { ...typography.caption, fontSize: 10, color: palette.gold },
  likeBtn: {
    position: "absolute",
    bottom: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  likeText: { ...typography.caption, color: palette.textMuted, fontWeight: "700" },
  likeActive: { color: palette.gold },
  empty: { ...typography.bodyMuted, textAlign: "center", paddingVertical: 24 },
});
