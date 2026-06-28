import React, { useCallback, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenLoading } from "../../components/LoadingState";
import { palette, typography } from "../../constants/theme";
import { fetchFollowupReminders, type FollowupReminder } from "../../services/socialPortfolioApi";
import { userFacingApiError } from "../../utils/userFacingApiError";

type Nav = {
  navigate: (name: string, params: Record<string, unknown>) => void;
};

export default function HaircutFollowupScreen() {
  const navigation = useNavigation<Nav>();
  const [loading, setLoading] = useState(true);
  const [reminders, setReminders] = useState<FollowupReminder[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchFollowupReminders();
      setReminders(rows.filter((r) => r.due || r.status === "sent"));
    } catch (e) {
      Alert.alert("Follow-up", userFacingApiError(e));
      setReminders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openUpload = (item: FollowupReminder) => {
    if (!item.reviewId) {
      Alert.alert(
        "Review required",
        "Leave a review for this appointment first, then you can add your 30-day update photo.",
        [
          {
            text: "Leave review",
            onPress: () =>
              navigation.navigate("BookingReview", {
                bookingId: item.bookingId,
                barberId: item.barberId,
                barberName: item.barberName,
                serviceName: item.service,
              }),
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
      return;
    }
    navigation.navigate("BookingReview", {
      bookingId: item.bookingId,
      barberId: item.barberId,
      barberName: item.barberName,
      serviceName: item.service,
      followupReviewId: item.reviewId,
      is30DayFollowup: true,
    });
  };

  return (
    <ProfileScreenLayout
      title="30-day updates"
      subtitle="Show how your cut grows out — barbers love seeing long-term results"
    >
      {loading ? <ScreenLoading /> : null}
      {!loading && !reminders.length ? (
        <Text style={styles.empty}>No follow-up reminders right now. Check back after your next cut.</Text>
      ) : null}
      <View style={styles.list}>
        {reminders.map((item) => (
          <ProfileCard key={item.id} style={styles.card}>
            <Text style={styles.title}>{item.barberName || "Your barber"}</Text>
            <Text style={styles.sub}>{item.service || "Haircut"} · {item.appointmentDate || "Recent visit"}</Text>
            <Text style={styles.hint}>Share an updated photo so others can see how this barber's work holds up.</Text>
            <GlowButton label="Upload 30-day photo" onPress={() => openUpload(item)} />
          </ProfileCard>
        ))}
      </View>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, marginTop: 8 },
  card: { gap: 8 },
  title: { ...typography.heading, color: palette.gold },
  sub: { ...typography.caption },
  hint: { ...typography.bodyMuted, lineHeight: 20 },
  empty: { ...typography.bodyMuted, textAlign: "center", marginTop: 24 },
});
