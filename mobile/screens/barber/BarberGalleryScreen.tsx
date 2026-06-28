import React, { useCallback, useState } from "react";
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { RouteProp, useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import StaffRosterGuard from "../../components/StaffRosterGuard";
import { ScreenLoading } from "../../components/LoadingState";
import { palette, radius, typography } from "../../constants/theme";
import {
  deleteGalleryPhoto,
  fetchBarberGallery,
  replaceGalleryPhoto,
  uploadBarberGalleryPhotos,
  type GalleryStyle,
} from "../../services/barberGalleryApi";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { compressReviewPhoto } from "../../utils/compressReviewPhoto";
import { getServiceCardImageUrl } from "../../utils/styleImageUrl";
import type { BarberDetailParams } from "./BarberDetailScreen";

type Route = RouteProp<{ BarberGallery: BarberDetailParams }, "BarberGallery">;

function BarberGalleryInner() {
  const route = useRoute<Route>();
  const navigation = useNavigation();
  const { barberId, barberName } = route.params;
  const { width } = useWindowDimensions();
  const colCount = width >= 768 ? 4 : 3;
  const gap = 8;
  const tile = Math.floor((Math.min(width, 720) - 32 - gap * (colCount - 1)) / colCount);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<GalleryStyle[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPhotos(await fetchBarberGallery(barberId));
    } catch (e) {
      Alert.alert("Gallery", userFacingApiError(e));
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [barberId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onUpload = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Allow photo access to upload haircut photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (result.canceled || !result.assets?.length) return;
    setBusy(true);
    try {
      const uris = await Promise.all(result.assets.map((a) => compressReviewPhoto(a.uri)));
      await uploadBarberGalleryPhotos(barberId, uris, { title: "Haircut" });
      await load();
      Alert.alert("Uploaded", "Photos are now live on your profile and booking screen.");
    } catch (e) {
      Alert.alert("Upload failed", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const onReplace = (photo: GalleryStyle) => {
    Alert.alert("Replace photo", "Choose a new image for this gallery item.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Replace",
        onPress: () => {
          void (async () => {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!perm.granted) return;
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.85,
            });
            if (result.canceled || !result.assets?.[0]) return;
            setBusy(true);
            try {
              const uri = await compressReviewPhoto(result.assets[0].uri);
              await replaceGalleryPhoto(String(photo.id), uri);
              await load();
            } catch (e) {
              Alert.alert("Replace failed", userFacingApiError(e));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const onDelete = (photo: GalleryStyle) => {
    Alert.alert("Delete photo", "Remove this photo from your gallery?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteGalleryPhoto(String(photo.id))
            .then(() => load())
            .catch((e) => Alert.alert("Delete failed", userFacingApiError(e)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <ProfileScreenLayout title="Haircut gallery" subtitle={barberName}>
      {loading ? <ScreenLoading /> : null}
      {!loading ? (
        <ScrollView contentContainerStyle={styles.scroll}>
          <ProfileCard style={styles.card}>
            <Text style={styles.hint}>
              Upload haircut photos — they appear on your public portfolio and the customer booking screen.
            </Text>
            <GlowButton label="Upload photos" onPress={() => void onUpload()} loading={busy} disabled={busy} />
          </ProfileCard>

          {photos.length ? (
            <View style={[styles.grid, { gap }]}>
              {photos.map((photo) => {
                const url = getServiceCardImageUrl(photo.image_url || photo.imageUrl || "");
                return (
                  <Pressable
                    key={String(photo.id)}
                    style={[styles.tile, { width: tile, height: tile }]}
                    onLongPress={() => onDelete(photo)}
                    onPress={() => onReplace(photo)}
                  >
                    {url ? <Image source={{ uri: url }} style={styles.image} resizeMode="cover" /> : null}
                    <Text style={styles.tileHint}>Tap replace · hold delete</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={styles.empty}>No photos yet. Upload your first haircut.</Text>
          )}
          <GlowButton label="Done" variant="outline" onPress={() => navigation.goBack()} />
        </ScrollView>
      ) : null}
    </ProfileScreenLayout>
  );
}

export default function BarberGalleryScreen() {
  return (
    <StaffRosterGuard>
      <BarberGalleryInner />
    </StaffRosterGuard>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32, gap: 12 },
  card: { gap: 10 },
  hint: { ...typography.bodyMuted, lineHeight: 20 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  tile: {
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: palette.bg2,
    borderWidth: 1,
    borderColor: palette.border,
  },
  image: { width: "100%", height: "100%" },
  tileHint: {
    position: "absolute",
    bottom: 4,
    left: 4,
    right: 4,
    ...typography.caption,
    fontSize: 9,
    color: palette.gold,
    backgroundColor: "rgba(0,0,0,0.55)",
    textAlign: "center",
    paddingVertical: 2,
    borderRadius: 4,
  },
  empty: { ...typography.bodyMuted, textAlign: "center", paddingVertical: 24 },
});
