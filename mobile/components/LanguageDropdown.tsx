import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { theme } from "../constants/theme";
import {
  getPickerLanguages,
  languageMeta,
  type SupportedLanguageCode,
} from "../i18n/languages";

type Props = {
  value: SupportedLanguageCode;
  onChange: (code: SupportedLanguageCode) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
};

/**
 * Searchable Language dropdown — options from getPickerLanguages() (feature-flag aware).
 * Shows English name + native name. No flags.
 */
export default function LanguageDropdown({
  value,
  onChange,
  disabled = false,
  label,
  hint,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = getPickerLanguages();
  const selected = languageMeta(value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (lang) =>
        lang.englishName.toLowerCase().includes(q) ||
        lang.nativeName.toLowerCase().includes(q) ||
        lang.code.toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <Pressable
        onPress={() => {
          if (disabled) return;
          setQuery("");
          setOpen(true);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("language.select", { defaultValue: "Language" })}
        style={({ pressed }) => [
          styles.trigger,
          disabled && styles.triggerDisabled,
          pressed && !disabled && styles.triggerPressed,
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.triggerTitle}>{selected.englishName}</Text>
          <Text style={styles.triggerSub}>
            {selected.nativeName} · {selected.code}
          </Text>
        </View>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>
              {t("language.title", { defaultValue: "Language" })}
            </Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("common.search", { defaultValue: "Search" })}
              placeholderTextColor={theme.colors.textMuted}
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.search}
              accessibilityLabel={t("common.search", { defaultValue: "Search" })}
            />
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 ? (
                <Text style={styles.empty}>{t("common.notFound", { defaultValue: "No matches" })}</Text>
              ) : (
                filtered.map((lang) => {
                  const active = lang.code === value;
                  return (
                    <Pressable
                      key={lang.code}
                      onPress={() => {
                        onChange(lang.code);
                        setOpen(false);
                      }}
                      style={({ pressed }) => [
                        styles.option,
                        active && styles.optionActive,
                        pressed && styles.optionPressed,
                      ]}
                    >
                      <Text style={[styles.optionTitle, active && styles.optionTitleActive]}>
                        {lang.englishName}
                      </Text>
                      <Text style={styles.optionSub}>{lang.nativeName}</Text>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%" },
  label: {
    color: theme.colors.gold,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  triggerPressed: { backgroundColor: "rgba(245,200,66,0.08)" },
  triggerDisabled: { opacity: 0.55 },
  triggerTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "700" },
  triggerSub: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  chevron: { color: theme.colors.gold, fontSize: 18, marginLeft: 8 },
  hint: { color: theme.colors.textMuted, fontSize: 12, marginTop: 8 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    backgroundColor: "#111",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    padding: 16,
  },
  sheetTitle: {
    color: theme.colors.gold,
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  search: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.colors.text,
    marginBottom: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  empty: { color: theme.colors.textMuted, padding: 12, textAlign: "center" },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  optionActive: { backgroundColor: "rgba(245,200,66,0.12)" },
  optionPressed: { backgroundColor: "rgba(255,255,255,0.06)" },
  optionTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "700" },
  optionTitleActive: { color: theme.colors.gold },
  optionSub: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
});
