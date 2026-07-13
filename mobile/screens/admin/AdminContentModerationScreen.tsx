import React, { useCallback, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { ScreenLoading } from "../../components/LoadingState";
import SuperAdminRouteGuard from "../../components/SuperAdminRouteGuard";
import { palette, typography } from "../../constants/theme";
import {
  fetchContentReports,
  hidePhoto,
  hideReview,
  removeReview,
  resolveContentReport,
  type ContentReport,
} from "../../services/socialPortfolioApi";
import { userFacingApiError } from "../../utils/userFacingApiError";

function ModerationInner() {
  const [loading, setLoading] = useState(true);
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReports(await fetchContentReports());
    } catch (e) {
      Alert.alert("Moderation", userFacingApiError(e));
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const act = async (report: ContentReport, action: "dismiss" | "hide" | "remove") => {
    setBusyId(report.id);
    try {
      if (action === "hide") {
        if (report.targetType === "review") await hideReview(report.targetId);
        else await hidePhoto(report.targetId);
        await resolveContentReport(report.id, { status: "action_taken", adminNotes: "Content hidden by admin" });
      } else if (action === "remove") {
        if (report.targetType === "review") await removeReview(report.targetId, report.reason || "policy_violation");
        else await hidePhoto(report.targetId);
        await resolveContentReport(report.id, { status: "action_taken", adminNotes: "Content removed by admin" });
      } else {
        await resolveContentReport(report.id, { status: "dismissed", adminNotes: "No action required" });
      }
      await load();
    } catch (e) {
      Alert.alert("Action failed", userFacingApiError(e));
    } finally {
      setBusyId("");
    }
  };

  return (
    <ProfileScreenLayout title="Content moderation" subtitle="Review reported photos and reviews" standalone>
      {loading ? <ScreenLoading /> : null}
      {!loading && !reports.length ? (
        <Text style={styles.empty}>No pending reports — all clear.</Text>
      ) : null}
      <View style={styles.list}>
        {reports.map((report) => (
          <ProfileCard key={report.id} style={styles.card}>
            <Text style={styles.type}>
              {report.targetType === "review" ? "Review" : "Photo"} · {report.reason}
            </Text>
            <Text style={styles.meta}>Target ID: {report.targetId}</Text>
            {report.details ? <Text style={styles.details}>{report.details}</Text> : null}
            <Text style={styles.date}>{report.createdAt ? new Date(report.createdAt).toLocaleString() : ""}</Text>
            <View style={styles.actions}>
              <GlowButton
                label="Hide content"
                variant="danger"
                disabled={busyId === report.id}
                onPress={() =>
                  Alert.alert("Hide content", "Remove this from public view?", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Hide", style: "destructive", onPress: () => void act(report, "hide") },
                  ])
                }
              />
              {report.targetType === "review" ? (
                <GlowButton
                  label="Remove review"
                  variant="danger"
                  disabled={busyId === report.id}
                  onPress={() =>
                    Alert.alert("Remove review", "Permanently delete this review?", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => void act(report, "remove") },
                    ])
                  }
                />
              ) : null}
              <GlowButton
                label="Dismiss"
                variant="outline"
                disabled={busyId === report.id}
                onPress={() => void act(report, "dismiss")}
              />
            </View>
          </ProfileCard>
        ))}
      </View>
    </ProfileScreenLayout>
  );
}

export default function AdminContentModerationScreen() {
  return (
    <SuperAdminRouteGuard>
      <ModerationInner />
    </SuperAdminRouteGuard>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, marginTop: 8 },
  card: { gap: 8 },
  type: { ...typography.heading, color: palette.gold, fontSize: 15 },
  meta: { ...typography.caption },
  details: { ...typography.bodyMuted },
  date: { ...typography.caption, fontSize: 11 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  empty: { ...typography.bodyMuted, textAlign: "center", marginTop: 24 },
});
