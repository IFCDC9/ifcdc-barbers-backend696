import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { palette, typography } from "../constants/theme";

export default function VerifiedClientBadge({ compact = false }: { compact?: boolean }) {
  return (
    <View style={[styles.badge, compact && styles.compact]}>
      <Text style={[styles.text, compact && styles.textCompact]}>✓ Verified Client</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: palette.goldBg,
    borderWidth: 1,
    borderColor: palette.borderGold,
  },
  compact: { paddingHorizontal: 8, paddingVertical: 2 },
  text: { ...typography.caption, color: palette.gold, fontWeight: "800", fontSize: 11 },
  textCompact: { fontSize: 10 },
});
