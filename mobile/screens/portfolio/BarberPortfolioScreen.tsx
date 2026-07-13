import React, { useCallback, useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { RouteProp, useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenLoading } from "../../components/LoadingState";
import StarRating, { RatingSummary } from "../../components/StarRating";
import VerifiedClientBadge from "../../components/VerifiedClientBadge";
import PortfolioPhotoGrid from "../../components/PortfolioPhotoGrid";
import { palette, radius, typography } from "../../constants/theme";
import {
  fetchBarberPortfolio,
  followPortfolioBarber,
  portfolioShareUrl,
  replyToPortfolioReview,
  reportPortfolioContent,
  togglePortfolioPhotoLike,
  unfollowPortfolioBarber,
  type BarberPortfolio,
  type PortfolioPhoto,
} from "../../services/socialPortfolioApi";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { useAuth } from "../../services/authContext";
import { getServiceCardImageUrl } from "../../utils/styleImageUrl";
import type { StackNavigationProp } from "@react-navigation/stack";
import type { ProfileStackParamList } from "../../navigation/ProfileStack";

export type BarberPortfolioParams = { slugOrId: string; barberName?: string };

type Route = RouteProp<{ BarberPortfolio: BarberPortfolioParams }, "BarberPortfolio">;

function formatMoney(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return "—";
  return `$${price.toFixed(0)}`;
}

export default function BarberPortfolioScreen() {
  const route = useRoute<Route>();
  const navigation = useNavigation<StackNavigationProp<ProfileStackParamList>>();
  const { token, user } = useAuth();
  const { width } = useWindowDimensions();
  const contentMax = Math.min(width, 820);
  const isWide = width >= 768;

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [portfolio, setPortfolio] = useState<BarberPortfolio | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"about" | "reviews" | "gallery">("about");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

  const canReply =
    Boolean(portfolio?.id) &&
    Boolean(user) &&
    (user?.role === "super_admin" ||
      user?.role === "admin" ||
      String((user as { barber_id?: string; barberId?: string })?.barber_id || (user as { barberId?: string })?.barberId || "") ===
        String(portfolio?.id || ""));

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchBarberPortfolio(route.params.slugOrId);
      setPortfolio(data);
    } catch (e) {
      setError(userFacingApiError(e));
      setPortfolio(null);
    } finally {
      setLoading(false);
    }
  }, [route.params.slugOrId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onFollow = async () => {
    if (!token || !portfolio) {
      Alert.alert("Sign in", "Log in to follow barbers.");
      return;
    }
    setBusy(true);
    try {
      if (portfolio.isFollowing) {
        await unfollowPortfolioBarber(portfolio.id);
        setPortfolio((p) =>
          p ? { ...p, isFollowing: false, followerCount: Math.max(0, p.followerCount - 1) } : p,
        );
      } else {
        await followPortfolioBarber(portfolio.id);
        setPortfolio((p) => (p ? { ...p, isFollowing: true, followerCount: p.followerCount + 1 } : p));
      }
    } catch (e) {
      Alert.alert("Follow", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const onShare = async () => {
    if (!portfolio) return;
    const url = portfolioShareUrl(portfolio.slug);
    try {
      await Share.share({
        title: `${portfolio.name} · IFCDC Barbers`,
        message: `Book ${portfolio.name} on IFCDC Barbers — ${url}`,
        url,
      });
    } catch {
      /* user dismissed */
    }
  };

  const onReply = async (reviewId: string) => {
    const text = String(replyDrafts[reviewId] || "").trim();
    if (!text) return;
    setBusy(true);
    try {
      const updated = await replyToPortfolioReview(reviewId, text);
      setPortfolio((p) =>
        p
          ? {
              ...p,
              reviews: p.reviews.map((r) =>
                r.id === reviewId ? { ...r, ...updated, photos: r.photos } : r,
              ),
            }
          : p,
      );
      setReplyDrafts((d) => ({ ...d, [reviewId]: "" }));
    } catch (e) {
      Alert.alert("Reply", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const onLike = async (photo: PortfolioPhoto) => {
    if (!token) {
      Alert.alert("Sign in", "Log in to like photos.");
      return;
    }
    try {
      const result = await togglePortfolioPhotoLike(photo.id);
      setPortfolio((p) => {
        if (!p) return p;
        const gallery = p.gallery.map((item) =>
          item.id === photo.id
            ? {
                ...item,
                likedByViewer: result.liked,
                likeCount:
                  result.likeCount ??
                  Math.max(0, item.likeCount + (result.liked ? 1 : -1)),
              }
            : item,
        );
        const reviews = p.reviews.map((review) => ({
          ...review,
          photos: review.photos.map((item) =>
            item.id === photo.id
              ? {
                  ...item,
                  likedByViewer: result.liked,
                  likeCount:
                    result.likeCount ??
                    Math.max(0, item.likeCount + (result.liked ? 1 : -1)),
                }
              : item,
          ),
        }));
        return { ...p, gallery, reviews };
      });
    } catch (e) {
      Alert.alert("Like", userFacingApiError(e));
    }
  };

  const onReportPhoto = (photo: PortfolioPhoto) => {
    if (!token) {
      Alert.alert("Sign in", "Log in to report content.");
      return;
    }
    Alert.alert("Report photo", "Why are you reporting this photo?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Inappropriate",
        style: "destructive",
        onPress: () =>
          void reportPortfolioContent({ targetType: "photo", targetId: photo.id, reason: "inappropriate" }).then(() =>
            Alert.alert("Reported", "Thank you — our team will review this."),
          ),
      },
    ]);
  };

  const onReportReview = (reviewId: string) => {
    if (!token) {
      Alert.alert("Sign in", "Log in to report content.");
      return;
    }
    Alert.alert("Report review", "Why are you reporting this review?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Inappropriate",
        style: "destructive",
        onPress: () =>
          void reportPortfolioContent({ targetType: "review", targetId: reviewId, reason: "inappropriate" }).then(() =>
            Alert.alert("Reported", "Thank you — our team will review this."),
          ),
      },
    ]);
  };

  const onBook = () => {
    if (!portfolio?.bookable) {
      Alert.alert("Booking unavailable", "This barber is not accepting bookings right now.");
      return;
    }
    navigation.getParent()?.navigate("Book" as never, { screen: "BookMain" } as never);
  };

  const isOwnPortfolio =
    Boolean(user?.barberId) && portfolio && String(user.barberId) === String(portfolio.id);

  const openEdit = (screen: string, params: object) => {
    if (!portfolio) return;
    const stackRoutes = navigation.getState()?.routeNames || [];
    if (stackRoutes.includes(screen)) {
      navigation.navigate(screen as never, params as never);
      return;
    }
    navigation.getParent()?.navigate("Profile" as never, { screen, params } as never);
  };

  if (loading) {
    return (
      <ProfileScreenLayout title="Barber portfolio" subtitle="Loading…">
        <ScreenLoading />
      </ProfileScreenLayout>
    );
  }

  if (!portfolio) {
    return (
      <ProfileScreenLayout title="Barber portfolio" subtitle={error || "Not found"}>
        <GlowButton label="Go back" variant="outline" onPress={() => navigation.goBack()} />
      </ProfileScreenLayout>
    );
  }

  return (
    <ProfileScreenLayout title={portfolio.name} subtitle={portfolio.headline || portfolio.shop.name || "Professional barber"}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { maxWidth: contentMax, alignSelf: "center", width: "100%" }]}
        showsVerticalScrollIndicator={false}
      >
        <ProfileCard glow style={styles.hero}>
          <View style={[styles.heroRow, isWide && styles.heroRowWide]}>
            {portfolio.profileImage ? (
              <Image source={{ uri: portfolio.profileImage }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarInitial}>{portfolio.name.slice(0, 1)}</Text>
              </View>
            )}
            <View style={styles.heroCopy}>
              <RatingSummary average={portfolio.averageRating} count={portfolio.reviewCount} />
              {portfolio.yearsExperience != null && portfolio.yearsExperience > 0 ? (
                <Text style={styles.meta}>{portfolio.yearsExperience}+ years experience</Text>
              ) : null}
              {portfolio.shop.locationLabel ? (
                <Text style={styles.meta}>{portfolio.shop.locationLabel}</Text>
              ) : null}
              <Text style={styles.meta}>{portfolio.followerCount} follower{portfolio.followerCount === 1 ? "" : "s"}</Text>
              <View style={styles.badges}>
                {portfolio.badges.map((b) => (
                  <View key={b.key} style={styles.badge}>
                    <Text style={styles.badgeText}>{b.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
          {portfolio.bio ? <Text style={styles.bio}>{portfolio.bio}</Text> : null}
          <View style={styles.actions}>
            {portfolio.bookable ? (
              <GlowButton label="Book now" onPress={onBook} disabled={busy} />
            ) : null}
            <GlowButton
              label={portfolio.isFollowing ? "Following" : "Follow"}
              variant="outline"
              onPress={() => void onFollow()}
              disabled={busy}
            />
            <GlowButton label="Share" variant="outline" onPress={() => void onShare()} disabled={busy} />
          </View>
          {isOwnPortfolio ? (
            <View style={styles.actions}>
              <GlowButton
                label="Edit profile"
                variant="outline"
                onPress={() =>
                  openEdit("BarberEdit", { barberId: portfolio.id, barberName: portfolio.name })
                }
              />
              <GlowButton
                label="Edit services"
                variant="outline"
                onPress={() =>
                  openEdit("BarberServices", { barberId: portfolio.id, barberName: portfolio.name })
                }
              />
              <GlowButton
                label="Manage gallery"
                variant="outline"
                onPress={() =>
                  openEdit("BarberGallery", { barberId: portfolio.id, barberName: portfolio.name })
                }
              />
            </View>
          ) : null}
        </ProfileCard>

        <View style={styles.tabs}>
          {(
            [
              { id: "about" as const, label: "About" },
              { id: "reviews" as const, label: `Reviews (${portfolio.reviewCount || 0})` },
              { id: "gallery" as const, label: "Gallery" },
            ] as const
          ).map((t) => (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
              <Text style={[styles.tabText, tab === t.id && styles.tabTextOn]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        {tab === "about" ? (
        <ProfileCard style={styles.section}>
          <Text style={styles.sectionTitle}>Services & portfolio</Text>
          {portfolio.services.length ? (
            portfolio.services.map((s) => (
              <View key={String(s.id)} style={styles.serviceRow}>
                {s.imageUrl ? (
                  <Image
                    source={{ uri: getServiceCardImageUrl(s.imageUrl) }}
                    style={styles.serviceThumb}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[styles.serviceThumb, styles.serviceThumbPlaceholder]}>
                    <Text style={styles.serviceThumbIcon}>{s.icon || "✂️"}</Text>
                  </View>
                )}
                <View style={styles.serviceCopy}>
                  <Text style={styles.serviceName}>{s.icon ? `${s.icon} ` : ""}{s.name}</Text>
                  {s.description ? <Text style={styles.serviceDesc}>{s.description}</Text> : null}
                  {s.durationMinutes ? <Text style={styles.duration}>{s.durationMinutes} min</Text> : null}
                </View>
                <View style={styles.servicePrice}>
                  <Text style={styles.price}>{formatMoney(s.price)}</Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.muted}>Services coming soon.</Text>
          )}
        </ProfileCard>
        ) : null}

        {tab === "gallery" ? (
          <ProfileCard style={styles.section}>
            <Text style={styles.sectionTitle}>Style gallery</Text>
            {portfolio.gallery.length ? (
              <PortfolioPhotoGrid photos={portfolio.gallery} onLike={onLike} onPhotoLongPress={onReportPhoto} />
            ) : (
              <Text style={styles.muted}>No gallery photos yet.</Text>
            )}
          </ProfileCard>
        ) : null}

        {tab === "reviews" ? (
        <ProfileCard style={styles.section}>
          <Text style={styles.sectionTitle}>Reviews</Text>
          <Text style={styles.muted}>
            {Number(portfolio.averageRating || 0).toFixed(1)} average · {portfolio.reviewCount} review
            {portfolio.reviewCount === 1 ? "" : "s"} · Verified clients only
          </Text>
          {portfolio.reviews.length ? (
            portfolio.reviews.map((review) => (
              <View key={review.id} style={styles.review}>
                <View style={styles.reviewHeader}>
                  <View>
                    <Text style={styles.reviewName}>{review.customerName}</Text>
                    {review.verifiedClient ? <VerifiedClientBadge compact /> : null}
                  </View>
                  <StarRating value={review.rating} size={14} />
                </View>
                {review.comment ? (
                  <Text style={styles.reviewComment} onLongPress={() => onReportReview(review.id)}>
                    {review.comment}
                  </Text>
                ) : null}
                {review.photos?.length ? (
                  <PortfolioPhotoGrid photos={review.photos} columns={3} onLike={onLike} onPhotoLongPress={onReportPhoto} />
                ) : null}
                {review.barberReply ? (
                  <View style={styles.replyBox}>
                    <Text style={styles.replyLabel}>Provider reply</Text>
                    <Text style={styles.muted}>{review.barberReply}</Text>
                  </View>
                ) : null}
                {canReply ? (
                  <View style={{ gap: 8, marginTop: 8 }}>
                    <TextInput
                      value={replyDrafts[review.id] || ""}
                      onChangeText={(v) => setReplyDrafts((d) => ({ ...d, [review.id]: v }))}
                      placeholder={review.barberReply ? "Update your public reply…" : "Reply publicly…"}
                      placeholderTextColor={palette.muted}
                      multiline
                      style={styles.replyInput}
                    />
                    <GlowButton
                      label={review.barberReply ? "Update reply" : "Post reply"}
                      variant="outline"
                      onPress={() => void onReply(review.id)}
                      disabled={busy}
                    />
                  </View>
                ) : null}
              </View>
            ))
          ) : (
            <Text style={styles.muted}>No reviews yet.</Text>
          )}
        </ProfileCard>
        ) : null}

        {(portfolio.shop.name || portfolio.shop.phone) && (
          <ProfileCard style={styles.section}>
            <Text style={styles.sectionTitle}>Shop</Text>
            {portfolio.shop.name ? <Text style={styles.shopLine}>{portfolio.shop.name}</Text> : null}
            {portfolio.shop.address ? <Text style={styles.muted}>{portfolio.shop.address}</Text> : null}
            {portfolio.shop.phone ? (
              <GlowButton
                label={`Call ${portfolio.shop.phone}`}
                variant="outline"
                onPress={() => void Linking.openURL(`tel:${portfolio.shop.phone.replace(/[^0-9+]/g, "")}`)}
              />
            ) : null}
          </ProfileCard>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 16, gap: 12 },
  hero: { gap: 14 },
  heroRow: { flexDirection: "column", gap: 14 },
  heroRowWide: { flexDirection: "row", alignItems: "flex-start" },
  avatar: { width: 96, height: 96, borderRadius: 48, borderWidth: 2, borderColor: palette.gold },
  avatarPlaceholder: { backgroundColor: palette.bg2, alignItems: "center", justifyContent: "center" },
  avatarInitial: { ...typography.title, fontSize: 36, color: palette.gold },
  heroCopy: { flex: 1, gap: 6 },
  meta: { ...typography.caption },
  bio: { ...typography.bodyMuted, lineHeight: 22 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: palette.goldBg,
    borderWidth: 1,
    borderColor: palette.borderGold,
  },
  badgeText: { ...typography.caption, color: palette.gold, fontWeight: "700", fontSize: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.border,
  },
  tabOn: { borderColor: palette.gold, backgroundColor: palette.goldBg },
  tabText: { ...typography.caption, color: palette.muted, fontWeight: "700" },
  tabTextOn: { color: palette.gold },
  section: { gap: 12 },
  sectionTitle: { ...typography.heading, color: palette.gold, fontSize: 15 },
  replyBox: {
    marginTop: 8,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.borderGold,
    backgroundColor: palette.goldBg,
    gap: 4,
  },
  replyLabel: { ...typography.caption, color: palette.gold, fontWeight: "700" },
  replyInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.md,
    padding: 10,
    color: palette.text,
    textAlignVertical: "top",
  },
  serviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  serviceThumb: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.borderGold,
  },
  serviceThumbPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.bg2,
  },
  serviceThumbIcon: { fontSize: 28 },
  serviceCopy: { flex: 1 },
  serviceName: { ...typography.heading, fontSize: 15 },
  serviceDesc: { ...typography.caption, marginTop: 4 },
  servicePrice: { alignItems: "flex-end" },
  price: { ...typography.heading, color: palette.gold },
  duration: { ...typography.caption },
  review: { gap: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  reviewHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  reviewName: { ...typography.heading, fontSize: 14 },
  reviewComment: { ...typography.bodyMuted, lineHeight: 20 },
  shopLine: { ...typography.heading, fontSize: 15 },
  muted: { ...typography.bodyMuted },
});
