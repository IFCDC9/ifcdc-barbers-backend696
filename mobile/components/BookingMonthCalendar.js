import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { fetchBookingCalendar } from "../services/bookingCalendarApi";
import { theme } from "../constants/theme";

const WEEK_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function statusStyle(status, selected) {
  if (selected) return styles.cellSelected;
  switch (status) {
    case "available":
      return styles.cellAvailable;
    case "fully_booked":
      return styles.cellBooked;
    case "day_off":
    case "closed":
      return styles.cellOff;
    case "vacation":
    case "blocked":
      return styles.cellVacation;
    case "past":
    case "outside_window":
    default:
      return styles.cellDisabled;
  }
}

/**
 * Full month calendar for booking date selection.
 * Emits YYYY-MM-DD via onSelectDate.
 */
export default function BookingMonthCalendar({
  barberId,
  barberName,
  value,
  durationMinutes = 30,
  onSelectDate,
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [daysByDate, setDaysByDate] = useState({});
  const [meta, setMeta] = useState({ today: "", lastBookableDate: "", bookingWindowDays: 90 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!barberId && !barberName) return;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchBookingCalendar({
          barberId,
          barberName,
          year,
          month,
          durationMinutes,
        });
        if (cancelled) return;
        const map = {};
        for (const d of data.days || []) map[d.date] = d;
        setDaysByDate(map);
        setMeta({
          today: data.today,
          lastBookableDate: data.lastBookableDate,
          bookingWindowDays: data.bookingWindowDays,
        });
      } catch (e) {
        if (!cancelled) setError(e?.message || "Could not load calendar");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [barberId, barberName, year, month, durationMinutes]);

  const cells = useMemo(() => {
    const first = new Date(year, month - 1, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const list = [];
    for (let i = 0; i < startPad; i += 1) list.push(null);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      list.push(ymd);
    }
    return list;
  }, [year, month]);

  const shiftMonth = (delta) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setHint("");
  };

  const goToday = () => {
    const n = new Date();
    setYear(n.getFullYear());
    setMonth(n.getMonth() + 1);
    setHint("");
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.nav}>
        <Pressable onPress={() => shiftMonth(-1)} style={styles.navBtn}>
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{monthLabel(year, month)}</Text>
        <Pressable onPress={() => shiftMonth(1)} style={styles.navBtn}>
          <Text style={styles.navText}>›</Text>
        </Pressable>
      </View>
      <Pressable onPress={goToday} style={styles.todayBtn}>
        <Text style={styles.todayText}>Today</Text>
      </Pressable>

      <View style={styles.weekRow}>
        {WEEK_HEADERS.map((h) => (
          <Text key={h} style={styles.weekHead}>
            {h}
          </Text>
        ))}
      </View>

      {loading ? <ActivityIndicator color={theme.colors.gold} style={{ marginVertical: 16 }} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.grid}>
        {cells.map((ymd, idx) => {
          if (!ymd) return <View key={`pad-${idx}`} style={styles.cell} />;
          const info = daysByDate[ymd] || { status: "outside_window", selectable: false };
          const selected = value === ymd;
          const dayNum = Number(ymd.slice(8, 10));
          return (
            <Pressable
              key={ymd}
              disabled={!info.selectable}
              onPress={() => {
                if (!info.selectable) {
                  setHint(info.message || "This date is unavailable.");
                  return;
                }
                setHint("");
                onSelectDate?.(ymd, info);
              }}
              onLongPress={() => setHint(info.message || (info.selectable ? "Available" : "Unavailable"))}
              style={[styles.cell, statusStyle(info.status, selected)]}
            >
              <Text
                style={[
                  styles.dayNum,
                  !info.selectable && styles.dayNumDisabled,
                  selected && styles.dayNumSelected,
                ]}
              >
                {dayNum}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <Text style={styles.legend}>
        Book up to {meta.bookingWindowDays || 90} days ahead · Gold = available · Dim = unavailable
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
  },
  navText: { color: theme.colors.gold, fontSize: 22, fontWeight: "700" },
  monthTitle: { color: theme.colors.text, fontSize: 17, fontWeight: "800" },
  todayBtn: { alignSelf: "center", marginBottom: 10 },
  todayText: { color: theme.colors.gold, fontWeight: "700", fontSize: 13 },
  weekRow: { flexDirection: "row", marginBottom: 6 },
  weekHead: { width: `${100 / 7}%`, textAlign: "center", color: theme.colors.textMuted, fontSize: 11, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    marginBottom: 4,
  },
  cellAvailable: { backgroundColor: "rgba(245,200,66,0.12)", borderWidth: 1, borderColor: "rgba(245,200,66,0.35)" },
  cellSelected: { backgroundColor: theme.colors.gold, borderWidth: 1, borderColor: theme.colors.gold },
  cellBooked: { backgroundColor: "rgba(248,113,113,0.12)" },
  cellOff: { backgroundColor: "rgba(148,163,184,0.12)" },
  cellVacation: { backgroundColor: "rgba(96,165,250,0.12)" },
  cellDisabled: { opacity: 0.35 },
  dayNum: { color: theme.colors.text, fontWeight: "700", fontSize: 14 },
  dayNumDisabled: { color: theme.colors.textMuted },
  dayNumSelected: { color: "#111" },
  hint: {
    marginTop: 10,
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 18,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.35)",
    backgroundColor: "rgba(245,200,66,0.08)",
  },
  legend: { marginTop: 8, color: theme.colors.textMuted, fontSize: 11, lineHeight: 16 },
  error: { color: "#f87171", marginBottom: 8 },
});
