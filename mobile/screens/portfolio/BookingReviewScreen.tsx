import React, { useCallback, useState } from "react";
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import StarRating from "../../components/StarRating";
import { palette, radius, typography } from "../../constants/theme";
import {
  submitBookingReview,
  uploadReviewPhoto,
  type PortfolioPhoto,
} from "../../services/socialPortfolioApi";
import { fetchPortfolioCategories, type PortfolioCategory } from "../../services/socialPortfolioApi";
import { userFacingApiError } from "../../utils/userFacingApiError";

export type BookingReviewParams = {
  bookingId: string;
  barberId: string;
  barberName: string;
  serviceName?: string;
  /** When uploading a 30-day follow-up to an existing review */
  followupReviewId?: string;
  parentPhotoId?: string;
  is30DayFollowup?: boolean;
};

type Route = RouteProp<{ BookingReview: BookingReviewParams }, "BookingReview">;

type LocalPhoto = { uri: string; photoType: "before" | "after" | "standard" };

const MAX_PHOTOS = 5;

export default function BookingReviewScreen() {
  const route = useRoute<Route>();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const contentMax = Math.min(width, 720);

  const {
    bookingId,
    barberName,
    serviceName,
    followupReviewId,
    parentPhotoId,
    is30DayFollowup,
  } = route.params;

  const followupOnly = Boolean(is30DayFollowup && followupReviewId);

  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [categories, setCategories] = useState<PortfolioCategory[]>([]);
  const [styleCategory, setStyleCategory] = useState("");
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    void fetchPortfolioCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  const pickPhotos = async (photoType: LocalPhoto["photoType"]) => {
    if (photos.length >= MAX_PHOTOS) {
      Alert.alert("Photo limit", `You can add up to ${MAX_PHOTOS} photos.`);
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Allow photo access to upload your haircut.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsMultipleSelection: !followupOnly,
      selectionLimit: Math.min(MAX_PHOTOS - photos.length, followupOnly ? 1 : 3),
    });
    if (result.canceled || !result.assets?.length) return;
    setPhotos((prev) => [
      ...prev,
      ...result.assets.slice(0, MAX_PHOTOS - prev.length).map((a) => ({ uri: a.uri, photoType })),
    ]);
  };

  const onSubmit = async () => {
    if (!followupOnly && (rating < 1 || rating > 5)) {
      Alert.alert("Rating required", "Please select a star rating.");
      return;
    }
    setBusy(true);
    try {
      if (followupOnly && followupReviewId) {
        for (const p of photos) {
          await uploadReviewPhoto(followupReviewId, p.uri, {
            barberName,
            photoType: p.photoType,
            styleCategory: styleCategory || undefined,
            caption: comment.trim() || undefined,
            is30DayFollowup: true,
            parentPhotoId,
          });
        }
        Alert.alert("Thank you!", "Your 30-day update has been shared.", [
          { text: "Done", onPress: () => navigation.goBack() },
        ]);
        return;
      }

      const review = await submitBookingReview(bookingId, {
        rating,
        comment: comment.trim(),
        photos: [],
      });

      let uploaded: PortfolioPhoto[] = [];
      for (const p of photos) {
        const batch = await uploadReviewPhoto(review.id, p.uri, {
          barberName,
          photoType: p.photoType,
          styleCategory: styleCategory || undefined,
          caption: comment.trim() || undefined,
        });
        uploaded = uploaded.concat(batch);
      }

      Alert.alert(
        "Review submitted",
        uploaded.length
          ? "Thank you — your review and photos are now on the barber's portfolio."
          : "Thank you for your feedback!",
        [{ text: "Done", onPress: () => navigation.goBack() }],
      );
    } catch (e) {
      Alert.alert("Could not submit", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProfileScreenLayout
      title={followupOnly ? "30-day update" : "Rate your visit"}
      subtitle={followupOnly ? `Share how your cut from ${barberName} is growing out` : `${barberName}${serviceName ? ` · ${serviceName}` : ""}`}
      headerTopPad={12}
    >
      <ScrollView contentContainerStyle={[styles.scroll, { maxWidth: contentMax, alignSelf: "center", width: "100%" }]}>
        {!followupOnly ? (
          <ProfileCard style={styles.card}>
            <Text style={styles.label}>Your rating</Text>
            <StarRating value={rating} onChange={setRating} size={36} />
            <Text style={styles.hint}>Only verified clients who completed a booking can leave reviews.</Text>
          </ProfileCard>
        ) : null}

        <ProfileCard style={styles.card}>
          <Text style={styles.label}>{followupOnly ? "Caption (optional)" : "Your review"}</Text>
          <TextInput
            style={styles.input}
            multiline
            placeholder={followupOnly ? "How is the cut holding up?" : "Tell others about your experience…"}
            placeholderTextColor={palette.textDim}
            value={comment}
            onChangeText={setComment}
            maxLength={2000}
          />
        </ProfileCard>

        {categories.length ? (
          <ProfileCard style={styles.card}>
            <Text style={styles.label}>Style category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {categories.map((cat) => {
                const active = styleCategory === cat.id;
                return (
                  <GlowButton
                    key={cat.id}
                    label={cat.label}
                    variant={active ? "primary" : "outline"}
                    onPress={() => setStyleCategory(active ? "" : cat.id)}
                    style={styles.chipBtn}
                  />
                );
              })}
            </ScrollView>
          </ProfileCard>
        ) : null}

        <ProfileCard style={styles.card}>
          <Text style={styles.label}>Photos {photos.length ? `(${photos.length}/${MAX_PHOTOS})` : ""}</Text>
          <Text style={styles.hint}>Add before & after shots to showcase the cut.</Text>
          <View style={styles.photoActions}>
            <GlowButton label="Add after photo" variant="outline" onPress={() => void pickPhotos("after")} disabled={busy} />
            {!followupOnly ? (
              <GlowButton label="Add before photo" variant="outline" onPress={() => void pickPhotos("before")} disabled={busy} />
            ) : null}
          </View>
          <View style={styles.previewRow}>
            {photos.map((p, idx) => (
              <View key={`${p.uri}-${idx}`} style={styles.previewWrap}>
                <Image source={{ uri: p.uri }} style={styles.preview} />
                <Text style={styles.previewTag}>{p.photoType}</Text>
              </View>
            ))}
          </View>
        </ProfileCard>

        <GlowButton
          label={followupOnly ? "Share 30-day photo" : "Submit review"}
          onPress={() => void onSubmit()}
          loading={busy}
          disabled={busy}
        />
        <View style={{ height: 32 }} />
      </ScrollView>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 24, gap: 12 },
  card: { gap: 10 },
  label: { ...typography.heading, color: palette.gold, fontSize: 14 },
  hint: { ...typography.caption, lineHeight: 18 },
  input: {
    minHeight: 100,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.md,
    padding: 12,
    color: palette.text,
    textAlignVertical: "top",
    ...typography.body,
  },
  chips: { gap: 8, paddingVertical: 4 },
  chipBtn: { marginRight: 0 },
  photoActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  previewRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  previewWrap: { position: "relative" },
  preview: { width: 88, height: 88, borderRadius: radius.sm, backgroundColor: palette.bg2 },
  previewTag: {
    position: "absolute",
    bottom: 4,
    left: 4,
    ...typography.caption,
    fontSize: 9,
    color: palette.gold,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 4,
    borderRadius: 4,
  },
});
