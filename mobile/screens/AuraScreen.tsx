import React from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AuraChatPanel from "../components/AuraChatPanel";
import CallAuraLine from "../components/CallAuraLine";
import DarkGradientBackground from "../components/DarkGradientBackground";
import { profileTabScrollBottomPad } from "../constants/profileLayout";
import { theme } from "../constants/theme";

export default function AuraScreen() {
  const insets = useSafeAreaInsets();
  const bottomPad = profileTabScrollBottomPad(insets.bottom);

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      <DarkGradientBackground />
      <View style={[styles.content, { paddingBottom: bottomPad }]}>
        <CallAuraLine style={styles.callLine} />
        <AuraChatPanel />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.bg0 },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  callLine: { marginTop: 0, marginBottom: 4 },
});
