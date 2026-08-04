import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import { palette, typography } from "../../constants/theme";
import { BACKEND_URL } from "../../constants/config";
import { useAuth } from "../../services/authContext";

type SmsRow = {
  id: string;
  created_at?: string;
  status?: string;
  category?: string;
  to_e164?: string | null;
  booking_id?: string | null;
  payment_ref?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  body_preview?: string | null;
};

export default function AdminSmsDeliveryScreen() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flags, setFlags] = useState<{ verifyEnabled?: boolean; notificationsEnabled?: boolean }>({});
  const [messages, setMessages] = useState<SmsRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const statusRes = await fetch(`${BACKEND_URL}/api/sms/status`, { headers });
      const statusJson = await statusRes.json().catch(() => ({}));
      setFlags(statusJson?.flags || {});

      const histRes = await fetch(`${BACKEND_URL}/api/sms/admin/history?limit=50`, { headers });
      const histJson = await histRes.json().catch(() => ({}));
      if (!histRes.ok) {
        setError(String(histJson?.message || histJson?.error || `HTTP ${histRes.status}`));
        setMessages([]);
        return;
      }
      setMessages(Array.isArray(histJson.messages) ? histJson.messages : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProfileScreenLayout title="SMS delivery" subtitle="Transactional message history · Super Admin">
      <View style={styles.flagBox}>
        <Text style={styles.flagText}>
          Verify: {flags.verifyEnabled ? "ON" : "OFF"} · Notifications:{" "}
          {flags.notificationsEnabled ? "ON" : "OFF"}
        </Text>
        <Text style={styles.hint}>Flags stay off until Twilio credentials are approved.</Text>
      </View>
      <Pressable onPress={() => void load()} style={styles.refresh} disabled={loading}>
        <Text style={styles.refreshLabel}>{loading ? "Loading…" : "Refresh"}</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && messages.length === 0 ? <ActivityIndicator color={palette.gold} /> : null}
      <ScrollView style={{ maxHeight: 520 }}>
        {messages.length === 0 && !loading ? (
          <Text style={styles.empty}>No SMS rows yet.</Text>
        ) : (
          messages.map((m) => (
            <View key={m.id} style={styles.card}>
              <Text style={styles.meta}>
                {String(m.created_at || "").replace("T", " ").slice(0, 19)} · {m.status} · {m.category}
              </Text>
              <Text style={styles.line}>To {m.to_e164 || "—"}</Text>
              <Text style={styles.line}>
                Booking {m.booking_id ? String(m.booking_id).slice(0, 8) : "—"}
                {m.payment_ref ? ` · pay ${String(m.payment_ref).slice(0, 10)}` : ""}
              </Text>
              {m.error_code || m.error_message ? (
                <Text style={styles.errLine}>{m.error_code || m.error_message}</Text>
              ) : null}
              <Text style={styles.preview}>{m.body_preview || "—"}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  flagBox: {
    borderWidth: 1,
    borderColor: "rgba(212,175,55,0.35)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  flagText: { ...typography.body, color: palette.gold, fontWeight: "700" },
  hint: { ...typography.caption, color: palette.muted, marginTop: 6 },
  refresh: {
    alignSelf: "flex-start",
    backgroundColor: palette.gold,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
  },
  refreshLabel: { color: "#111", fontWeight: "800" },
  error: { color: "#f88", marginBottom: 8 },
  empty: { color: palette.muted, marginTop: 8 },
  card: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    backgroundColor: "rgba(15,15,15,0.9)",
  },
  meta: { color: palette.gold, fontSize: 12, marginBottom: 4 },
  line: { color: "#ddd", fontSize: 13 },
  errLine: { color: "#f88", fontSize: 12, marginTop: 4 },
  preview: { color: "#aaa", fontSize: 12, marginTop: 6 },
});
