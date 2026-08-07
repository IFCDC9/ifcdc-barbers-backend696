import React, { useCallback } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuraCallPhone } from "../hooks/useAuraCallPhone";
import { buildCallAuraLabel } from "../utils/auraPhone";
import { palette, typography } from "../constants/theme";

type Props = {
  /** Optional override shop name (e.g. viewing a specific shop). */
  shopName?: string | null;
  style?: object;
};

/**
 * Single clickable AURA telephone line — one icon, one number, no Text SMS.
 * Opens the device dialer via tel:+E164.
 */
export default function CallAuraLine({ shopName: shopNameProp = null, style }: Props) {
  const { display, shopName, telHref, loading } = useAuraCallPhone();
  const label = buildCallAuraLabel(shopNameProp ?? shopName, display);

  const onPress = useCallback(() => {
    Linking.openURL(telHref).catch(() => {
      Alert.alert("Unable to call", "Could not open the phone dialer on this device.");
    });
  }, [telHref]);

  return (
    <View style={[styles.wrap, style]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label.replace(/^☎️\s*/, "")}
        accessibilityHint="Opens the phone dialer to call AURA"
        hitSlop={8}
        style={({ pressed }) => [styles.pressable, pressed ? styles.pressed : null]}
      >
        <Text style={styles.line}>{loading ? `☎️ Call AURA: ${display}` : label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    alignItems: "center",
    marginTop: 10,
  },
  pressable: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(212, 175, 55, 0.45)",
  },
  pressed: {
    opacity: 0.75,
  },
  line: {
    ...typography.body,
    color: palette.gold,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.2,
    textAlign: "center",
  },
});
