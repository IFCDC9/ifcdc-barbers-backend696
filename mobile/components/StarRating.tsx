import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { palette, typography } from "../constants/theme";

type Props = {
  value: number;
  onChange?: (rating: number) => void;
  size?: number;
};

export default function StarRating({ value, onChange, size = 28 }: Props) {
  const interactive = typeof onChange === "function";
  return (
    <View style={styles.row} accessibilityRole={interactive ? "adjustable" : "text"}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= Math.round(value);
        const StarWrap = interactive ? Pressable : View;
        return (
          <StarWrap
            key={star}
            onPress={interactive ? () => onChange!(star) : undefined}
            style={({ pressed }: { pressed?: boolean }) => [styles.star, pressed && interactive && styles.pressed]}
            accessibilityLabel={`${star} star${star === 1 ? "" : "s"}`}
          >
            <Text style={[styles.glyph, { fontSize: size, color: filled ? palette.gold : palette.textDim }]}>
              ★
            </Text>
          </StarWrap>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  star: { padding: 2 },
  pressed: { opacity: 0.75, transform: [{ scale: 1.08 }] },
  glyph: { fontWeight: "700" },
});

export function RatingSummary({ average, count }: { average: number; count: number }) {
  return (
    <View style={summaryStyles.wrap}>
      <Text style={summaryStyles.average}>{average > 0 ? average.toFixed(1) : "—"}</Text>
      <View>
        <StarRating value={average} size={16} />
        <Text style={summaryStyles.count}>
          {count} review{count === 1 ? "" : "s"}
        </Text>
      </View>
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 12 },
  average: { ...typography.title, fontSize: 36, color: palette.gold, fontWeight: "800" },
  count: { ...typography.caption, marginTop: 4 },
});
