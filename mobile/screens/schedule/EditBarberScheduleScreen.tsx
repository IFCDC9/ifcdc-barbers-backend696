import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import ScheduleTimeField from "../../components/ScheduleTimeField";
import { UNAVAILABILITY_REASON_OPTIONS } from "../../constants/unavailabilityReasons";
import {
  fetchBarberSchedule,
  saveBarberSchedule,
  type BreakRow,
} from "../../services/barberScheduleApi";
import { emitScheduleUpdated } from "../../services/scheduleEvents";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { UX } from "../../utils/uxCopy";
import { theme } from "../../constants/theme";
import {
  defaultEditScheduleState,
  editStateToSavePayload,
  isValidTimeHHMM,
  scheduleToEditState,
  type EditScheduleState,
} from "../../utils/scheduleModel";

export type EditBarberScheduleParams = {
  barberId: string;
  barberName: string;
};

type EditRoute = RouteProp<{ EditBarberSchedule: EditBarberScheduleParams }, "EditBarberSchedule">;

const INTERVAL_OPTIONS = [15, 30, 45, 60];

export default function EditBarberScheduleScreen() {
  const navigation = useNavigation();
  const route = useRoute<EditRoute>();
  const { barberId, barberName } = route.params;

  const [state, setState] = useState<EditScheduleState>(defaultEditScheduleState());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [usingDefaults, setUsingDefaults] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setUsingDefaults(false);
    try {
      const schedule = await fetchBarberSchedule(barberId);
      setState(scheduleToEditState(schedule));
    } catch {
      setState(defaultEditScheduleState());
      setUsingDefaults(true);
    } finally {
      setLoading(false);
    }
  }, [barberId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateDay = (dow: number, patch: Partial<EditScheduleState["days"][0]>) => {
    setState((prev) => ({
      ...prev,
      days: prev.days.map((d) => (d.day_of_week === dow ? { ...d, ...patch } : d)),
    }));
  };

  const addBreak = () => {
    setState((prev) => ({
      ...prev,
      breaks: [...prev.breaks, { day_of_week: 1, start_time: "12:00", end_time: "13:00" }],
    }));
  };

  const updateBreak = (index: number, patch: Partial<BreakRow>) => {
    setState((prev) => ({
      ...prev,
      breaks: prev.breaks.map((b, i) => (i === index ? { ...b, ...patch } : b)),
    }));
  };

  const removeBreak = (index: number) => {
    setState((prev) => ({ ...prev, breaks: prev.breaks.filter((_, i) => i !== index) }));
  };

  const addBlockedDate = () => {
    setState((prev) => ({
      ...prev,
      blockedDates: [
        ...prev.blockedDates,
        { blocked_date: "", note: "", client_reason: "", return_date: "", client_message: "" },
      ],
    }));
  };

  const updateBlocked = (
    index: number,
    patch: Partial<EditScheduleState["blockedDates"][0]>,
  ) => {
    setState((prev) => ({
      ...prev,
      blockedDates: prev.blockedDates.map((b, i) => (i === index ? { ...b, ...patch } : b)),
    }));
  };

  const removeBlocked = (index: number) => {
    setState((prev) => ({ ...prev, blockedDates: prev.blockedDates.filter((_, i) => i !== index) }));
  };

  const onSave = async () => {
    for (const d of state.days) {
      if (!d.enabled) continue;
      if (!isValidTimeHHMM(d.start_time) || !isValidTimeHHMM(d.end_time)) {
        Alert.alert("Invalid time", `${WEEKDAYS.find((w) => w.dow === d.day_of_week)?.label}: use HH:MM format.`);
        return;
      }
    }
    for (const b of state.breaks) {
      if (!isValidTimeHHMM(b.start_time) || !isValidTimeHHMM(b.end_time)) {
        Alert.alert("Invalid break", "Break times must be HH:MM.");
        return;
      }
    }
    for (const bd of state.blockedDates) {
      if (bd.blocked_date && !/^\d{4}-\d{2}-\d{2}$/.test(bd.blocked_date)) {
        Alert.alert("Invalid date", "Blocked dates must be YYYY-MM-DD.");
        return;
      }
    }

    setSaving(true);
    try {
      await saveBarberSchedule(barberId, editStateToSavePayload(state));
      emitScheduleUpdated();
      Alert.alert("Saved", "Schedule updated. Booking slots will refresh.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert("Save failed", userFacingApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileScreenLayout title="Edit Schedule" subtitle={barberName}>
      {loading ? <ActivityIndicator color={theme.colors.gold} style={{ marginTop: 24 }} /> : null}
      {usingDefaults && !loading ? (
        <ProfileCard>
          <Text style={styles.notice}>{UX.scheduleLoadIssue}</Text>
        </ProfileCard>
      ) : null}

      {!loading ? (
        <>
          <ProfileCard>
            <Text style={styles.sectionTitle}>Working days</Text>
            {state.days.map((d) => {
              const meta = WEEKDAYS.find((w) => w.dow === d.day_of_week)!;
              return (
                <View key={d.day_of_week} style={styles.dayBlock}>
                  <Pressable
                    onPress={() => updateDay(d.day_of_week, { enabled: !d.enabled })}
                    style={[styles.dayToggle, d.enabled && styles.dayToggleOn]}
                  >
                    <Text style={[styles.dayToggleText, d.enabled && styles.dayToggleTextOn]}>
                      {meta.label}
                    </Text>
                  </Pressable>
                  {d.enabled ? (
                    <View style={styles.timeRow}>
                      <ScheduleTimeField
                        label="Start"
                        value={d.start_time}
                        onChange={(v) => updateDay(d.day_of_week, { start_time: v })}
                      />
                      <ScheduleTimeField
                        label="End"
                        value={d.end_time}
                        onChange={(v) => updateDay(d.day_of_week, { end_time: v })}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ProfileCard>

          <ProfileCard>
            <Text style={styles.sectionTitle}>Break times</Text>
            {state.breaks.length === 0 ? (
              <Text style={styles.muted}>No breaks configured.</Text>
            ) : null}
            {state.breaks.map((b, index) => (
              <View key={`break-${index}`} style={styles.breakBlock}>
                <View style={styles.dayPickerRow}>
                  {WEEKDAYS.map((w) => (
                    <Pressable
                      key={w.dow}
                      onPress={() => updateBreak(index, { day_of_week: w.dow })}
                      style={[styles.dayChip, b.day_of_week === w.dow && styles.dayChipOn]}
                    >
                      <Text style={[styles.dayChipText, b.day_of_week === w.dow && styles.dayChipTextOn]}>
                        {w.short}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.timeRow}>
                  <ScheduleTimeField
                    label="Start"
                    value={b.start_time}
                    onChange={(v) => updateBreak(index, { start_time: v })}
                  />
                  <ScheduleTimeField
                    label="End"
                    value={b.end_time}
                    onChange={(v) => updateBreak(index, { end_time: v })}
                  />
                </View>
                <Pressable onPress={() => removeBreak(index)}>
                  <Text style={styles.removeLink}>Remove break</Text>
                </Pressable>
              </View>
            ))}
            <GlowButton label="+ Add break" variant="outline" onPress={addBreak} />
          </ProfileCard>

          <ProfileCard>
            <Text style={styles.sectionTitle}>Time off / blocked dates</Text>
            <Text style={styles.muted}>
              Clients cannot book on these days. Choose a client-facing reason — private notes are never shown.
            </Text>
            {state.blockedDates.length === 0 ? (
              <Text style={styles.muted}>No blocked dates.</Text>
            ) : null}
            {state.blockedDates.map((bd, index) => (
              <View key={`blocked-${index}`} style={styles.blockedRow}>
                <TextInput
                  value={bd.blocked_date}
                  onChangeText={(v) => updateBlocked(index, { blocked_date: v })}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={styles.dateInput}
                />
                <Text style={styles.fieldLabel}>Client-facing reason</Text>
                <View style={styles.reasonWrap}>
                  {UNAVAILABILITY_REASON_OPTIONS.map((opt) => {
                    const selected = (bd.client_reason || "") === opt.code;
                    return (
                      <Pressable
                        key={opt.code || "default"}
                        onPress={() => updateBlocked(index, { client_reason: opt.code })}
                        style={[styles.reasonChip, selected && styles.reasonChipOn]}
                      >
                        <Text style={[styles.reasonChipText, selected && styles.reasonChipTextOn]}>
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {bd.client_reason === "custom" ? (
                  <TextInput
                    value={bd.client_message}
                    onChangeText={(v) => updateBlocked(index, { client_message: v })}
                    placeholder="Custom message shown to clients"
                    placeholderTextColor="rgba(255,255,255,0.35)"
                    style={[styles.dateInput, { flex: 1 }]}
                  />
                ) : null}
                <TextInput
                  value={bd.return_date}
                  onChangeText={(v) => updateBlocked(index, { return_date: v })}
                  placeholder="Return date YYYY-MM-DD (optional)"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={styles.dateInput}
                />
                <TextInput
                  value={bd.note}
                  onChangeText={(v) => updateBlocked(index, { note: v })}
                  placeholder="Private note (not shown to clients)"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={[styles.dateInput, { flex: 1 }]}
                />
                <Pressable onPress={() => removeBlocked(index)}>
                  <Text style={styles.removeLink}>Remove</Text>
                </Pressable>
              </View>
            ))}
            <GlowButton label="+ Add blocked date" variant="outline" onPress={addBlockedDate} />
          </ProfileCard>

          <ProfileCard>
            <Text style={styles.sectionTitle}>Appointment interval</Text>
            <View style={styles.intervalRow}>
              {INTERVAL_OPTIONS.map((n) => (
                <Pressable
                  key={n}
                  onPress={() => setState((prev) => ({ ...prev, appointment_interval_minutes: n }))}
                  style={[
                    styles.intervalChip,
                    state.appointment_interval_minutes === n && styles.intervalChipOn,
                  ]}
                >
                  <Text
                    style={[
                      styles.intervalText,
                      state.appointment_interval_minutes === n && styles.intervalTextOn,
                    ]}
                  >
                    {n} min
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.sectionTitle}>Timezone</Text>
            <TextInput
              value={state.timezone}
              onChangeText={(v) => setState((prev) => ({ ...prev, timezone: v }))}
              placeholder="America/New_York"
              placeholderTextColor="rgba(255,255,255,0.35)"
              autoCapitalize="none"
              style={styles.dateInput}
            />
          </ProfileCard>

          <GlowButton label={saving ? "Saving…" : "Save schedule"} onPress={onSave} disabled={saving} loading={saving} />
        </>
      ) : null}
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { color: theme.colors.gold, fontSize: 15, fontWeight: "800", marginBottom: 12 },
  dayBlock: { marginBottom: 14, gap: 8 },
  dayToggle: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  dayToggleOn: {
    borderColor: theme.colors.borderGold,
    backgroundColor: "rgba(245,200,66,0.12)",
  },
  dayToggleText: { color: theme.colors.textMuted, fontWeight: "700", fontSize: 14 },
  dayToggleTextOn: { color: theme.colors.gold },
  timeRow: { flexDirection: "row", gap: 10 },
  breakBlock: { marginBottom: 16, gap: 8 },
  dayPickerRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  dayChip: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dayChipOn: { borderColor: theme.colors.borderGold, backgroundColor: "rgba(245,200,66,0.12)" },
  dayChipText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "700" },
  dayChipTextOn: { color: theme.colors.gold },
  removeLink: { color: "#f87171", fontSize: 13, fontWeight: "600", marginTop: 4 },
  blockedRow: { gap: 8, marginBottom: 12 },
  fieldLabel: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "600" },
  reasonWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  reasonChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: "100%",
  },
  reasonChipOn: { borderColor: theme.colors.borderGold, backgroundColor: "rgba(245,200,66,0.12)" },
  reasonChipText: { color: theme.colors.textMuted, fontSize: 11, fontWeight: "600" },
  reasonChipTextOn: { color: theme.colors.gold },
  dateInput: {
    color: theme.colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  intervalRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  intervalChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  intervalChipOn: { borderColor: theme.colors.borderGold, backgroundColor: "rgba(245,200,66,0.12)" },
  intervalText: { color: theme.colors.textMuted, fontWeight: "700" },
  intervalTextOn: { color: theme.colors.gold },
  muted: { color: theme.colors.textMuted, fontSize: 14, marginBottom: 10 },
  notice: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
});
