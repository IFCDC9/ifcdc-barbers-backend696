import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type RefreshControlProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import ProfileAmbientBackground from "./ProfileAmbientBackground";
import { profileScrollBottomPad, profileTabScrollBottomPad } from "../constants/profileLayout";
import { palette, radius, typography } from "../constants/theme";

type Props = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Tab root — no back button, tighter bottom pad (no floating AURA). */
  standalone?: boolean;
  /** Extra space below the status bar / header block. */
  headerTopPad?: number;
  refreshControl?: React.ReactElement<RefreshControlProps>;
};

export default function ProfileScreenLayout({
  title,
  subtitle,
  children,
  standalone = false,
  headerTopPad = 0,
  refreshControl,
}: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const bottomPad = standalone
    ? profileTabScrollBottomPad(insets.bottom)
    : profileScrollBottomPad(insets.bottom);

  return (
    <View style={styles.root}>
      <ProfileAmbientBackground />
      <View style={[styles.header, { paddingTop: insets.top + headerTopPad }]}>
        <View style={styles.topBar}>
          {standalone ? (
            <View style={styles.backSpacer} />
          ) : (
            <Pressable
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Text style={styles.backText}>‹ Back</Text>
            </Pressable>
          )}
          <Text style={styles.topTitle} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.82}>
            {title}
          </Text>
          <View style={styles.backSpacer} />
        </View>
        <View pointerEvents="none" style={styles.titleAccent} />
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={refreshControl}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg0 },
  header: { zIndex: 1 },
  scroll: { flex: 1, zIndex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  backBtn: {
    minWidth: 72,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  },
  backBtnPressed: { backgroundColor: "rgba(245,200,66,0.10)" },
  backText: { color: palette.gold, fontSize: 16, fontWeight: "700" },
  topTitle: {
    ...typography.heading,
    flex: 1,
    flexShrink: 1,
    textAlign: "center",
    fontSize: 17,
    lineHeight: 22,
  },
  backSpacer: { minWidth: 72 },
  titleAccent: {
    alignSelf: "center",
    marginTop: 6,
    width: 36,
    height: 2,
    borderRadius: 2,
    backgroundColor: palette.goldSoft,
  },
  subtitle: {
    color: palette.textMuted,
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
    alignSelf: "center",
    width: "100%",
    paddingHorizontal: 28,
    marginTop: 10,
    marginBottom: 14,
    lineHeight: 20,
  },
  scrollContent: { paddingHorizontal: 24, gap: 12, paddingTop: 4 },
});
