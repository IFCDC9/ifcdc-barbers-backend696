import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../constants/theme";
import { CUSTOMER_ACCOUNT, PROVIDER_TYPES, type ProviderTypeId } from "../constants/providerTypes";

export type AccountSelection = "customer" | ProviderTypeId;

const buildOptions = (includeAll?: boolean): { id: AccountSelection | ""; label: string }[] => [
  ...(includeAll ? [{ id: "" as const, label: "All provider types" }] : []),
  { id: CUSTOMER_ACCOUNT.id as AccountSelection, label: CUSTOMER_ACCOUNT.label },
  ...PROVIDER_TYPES.map((p) => ({ id: p.id as AccountSelection, label: p.label })),
];

type Props = {
  value: AccountSelection | "";
  onChange: (value: AccountSelection | "") => void;
  disabled?: boolean;
  label?: string;
  includeAll?: boolean;
  registrationMode?: boolean;
};

export default function ProviderTypeDropdown({
  value,
  onChange,
  disabled = false,
  label,
  includeAll = false,
  registrationMode = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const options = registrationMode
    ? buildOptions(false)
    : buildOptions(includeAll).filter((o) => o.id !== CUSTOMER_ACCOUNT.id);
  const selected = options.find((o) => o.id === value) ?? options[0];

  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        style={({ pressed }) => [styles.trigger, pressed && !disabled && styles.triggerPressed]}
      >
        <Text style={styles.triggerTitle}>{selected.label}</Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>Select account type</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {options.map((opt) => (
                <Pressable
                  key={opt.id || "all"}
                  onPress={() => {
                    onChange(opt.id);
                    setOpen(false);
                  }}
                  style={[styles.option, value === opt.id && styles.optionActive]}
                >
                  <Text style={[styles.optionTitle, value === opt.id && styles.optionTitleActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
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
    textTransform: "uppercase",
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  triggerPressed: { backgroundColor: "rgba(245,200,66,0.08)" },
  triggerTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "700" },
  chevron: { color: theme.colors.gold, fontSize: 18 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", padding: 24 },
  sheet: {
    backgroundColor: "#111",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    padding: 16,
  },
  sheetTitle: { color: theme.colors.gold, fontSize: 14, fontWeight: "800", marginBottom: 12 },
  option: { paddingVertical: 12, paddingHorizontal: 8, borderRadius: 10 },
  optionActive: { backgroundColor: "rgba(245,200,66,0.12)" },
  optionTitle: { color: theme.colors.text, fontSize: 16, fontWeight: "600" },
  optionTitleActive: { color: theme.colors.gold },
});
