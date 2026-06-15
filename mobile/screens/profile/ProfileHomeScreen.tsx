import React, { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../services/authContext";
import ProfileCard from "../../components/ProfileCard";
import ProfileAmbientBackground from "../../components/ProfileAmbientBackground";
import GlowButton from "../../components/GlowButton";
import { profileHomeBottomPad } from "../../constants/profileLayout";
import { palette, typography, ui } from "../../constants/theme";
import type { ProfileStackParamList } from "../../navigation/ProfileStack";

function initialsFrom(name: string, email: string): string {
  const n = name.trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  const e = email.trim();
  return e.length >= 2 ? e.slice(0, 2).toUpperCase() : "IF";
}

export default function ProfileHomeScreen() {
  const navigation = useNavigation<StackNavigationProp<ProfileStackParamList>>();
  const { user, loading, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const bottomPad = profileHomeBottomPad(insets.bottom);
  const { t } = useTranslation();

  const [localAvatar, setLocalAvatar] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    AsyncStorage.getItem(`ifcdc_profile_avatar_${user.id}`).then((uri) => {
      if (uri) setLocalAvatar(uri);
    });
  }, [user?.id]);

  const displayName = loading ? "…" : user?.name || "IFCDC Member";
  const displayEmail = loading ? t("common.loading") : user?.email || "—";
  const avatarLetters = initialsFrom(user?.name || "", user?.email || "");
  const avatarUri = localAvatar || user?.profileImageUrl || null;

  // Customer Profile only — shop/barber/admin tools live under the Admin tab.
  const menu: { key: keyof ProfileStackParamList; label: string }[] = [
    { key: "EditProfile", label: t("profile.menuPersonalInfo") },
    { key: "BookingHistory", label: t("profile.menuBookings") },
    { key: "Notifications", label: t("profile.menuNotifications") },
    { key: "LanguageSettings", label: t("profile.menuLanguage") },
    { key: "SupportHelp", label: t("profile.menuSupport") },
    { key: "LegalPolicies", label: t("profile.menuLegal") },
    { key: "DeleteAccount", label: t("profile.menuDeleteAccount") },
  ];

  return (
    <View style={styles.root}>
      <ProfileAmbientBackground />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.screenTitle}>{t("profile.title")}</Text>
        <Text style={styles.screenSub}>{t("profile.accountHeader")}</Text>

        <ProfileCard glow style={styles.headerCard}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarRing}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{avatarLetters}</Text>
              </View>
            </View>
          )}
          <Text style={styles.userName}>{displayName}</Text>
          <Text style={styles.userEmail}>{displayEmail}</Text>
        </ProfileCard>

        <ProfileCard style={styles.menuCard}>
          {menu.map((item, index) => (
            <Pressable
              key={item.key}
              onPress={() => navigation.navigate(item.key as never)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.menuRow,
                index < menu.length - 1 && styles.menuRowBorder,
                pressed && styles.menuRowPressed,
              ]}
            >
              <Text
                style={[
                  styles.menuLabel,
                  item.key === "DeleteAccount" ? styles.menuLabelDanger : null,
                ]}
              >
                {item.label}
              </Text>
              <Text style={styles.menuChevron}>›</Text>
            </Pressable>
          ))}
        </ProfileCard>

        <ProfileCard style={styles.signOutCard}>
          <GlowButton
            label={t("profile.menuSignOut")}
            variant="outline"
            onPress={() => {
              Alert.alert(t("profile.signOutConfirmTitle"), t("profile.signOutConfirmBody"), [
                { text: t("common.cancel"), style: "cancel" },
                {
                  text: t("profile.menuSignOut"),
                  style: "destructive",
                  onPress: () => signOut(),
                },
              ]);
            }}
          />
        </ProfileCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg0 },
  scroll: { flex: 1, zIndex: 1 },
  content: { paddingHorizontal: ui.horizontalPad, paddingTop: 8, gap: ui.cardGap + 4 },
  screenTitle: { ...ui.screenTitle, marginBottom: 2 },
  screenSub: { ...ui.sectionTitle, marginTop: -8, marginBottom: 8 },
  headerCard: { alignItems: "center", paddingVertical: 28, paddingHorizontal: 20 },
  avatarRing: {
    padding: 3,
    borderRadius: 48,
    borderWidth: 1,
    borderColor: palette.borderGold,
    marginBottom: 16,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: palette.bg1,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: {
    width: 78,
    height: 78,
    borderRadius: 39,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: palette.borderGold,
  },
  avatarText: { color: palette.gold, fontSize: 22, fontWeight: "900" },
  userName: { ...typography.title, marginBottom: 6 },
  userEmail: { ...typography.bodyMuted },
  menuCard: { paddingVertical: 4, paddingHorizontal: 0 },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  menuRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  menuRowPressed: { backgroundColor: "rgba(245,200,66,0.06)" },
  menuLabel: { ...typography.heading, fontSize: 16, fontWeight: "600" },
  menuLabelDanger: { color: "#ff6b6b" },
  menuChevron: { color: palette.gold, fontSize: 22, fontWeight: "300" },
  signOutCard: { marginTop: 4 },
});
