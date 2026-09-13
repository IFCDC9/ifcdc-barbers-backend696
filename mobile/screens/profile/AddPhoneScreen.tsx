import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { useAuth } from "../../services/authContext";
import { requestPhoneVerification, verifyPhoneCode } from "../../services/profileApi";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";

function isVerified(user: { phoneVerified?: boolean; phone?: string | null } | null) {
  return user?.phoneVerified === true;
}

function last4(phone: string | null | undefined) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 4) return "";
  return d.slice(-4);
}

export default function AddPhoneScreen() {
  const { user, refresh } = useAuth();
  const verified = isVerified(user);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"enter" | "code">(verified ? "enter" : "enter");
  const [masked, setMasked] = useState(verified && last4(user?.phone) ? `••••${last4(user?.phone)}` : "");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(
    verified ? "Phone verified. You can replace it by sending a new code." : "",
  );
  const [error, setError] = useState("");

  const canSend = useMemo(() => phone.replace(/\D/g, "").length >= 10 && !busy, [phone, busy]);
  const canVerify = useMemo(() => /^\d{6}$/.test(code.trim()) && !busy, [code, busy]);

  const onSend = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await requestPhoneVerification(phone.trim());
      setMasked(res.toMasked || "");
      setInfo(res.message || "Code sent.");
      if (!res.alreadyVerified) {
        setStep("code");
        setCode("");
      } else {
        await refresh();
      }
    } catch (e) {
      setError(userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await verifyPhoneCode(code.trim());
      setInfo(res.message || "Phone verified.");
      setMasked(res.toMasked || masked);
      setStep("enter");
      setCode("");
      await refresh();
    } catch (e) {
      setError(userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProfileScreenLayout title="Add Phone" subtitle="Verify a mobile number on this account">
      <ProfileCard style={styles.card}>
        <Text style={styles.status}>{verified ? "Phone Verified" : "Not verified yet"}</Text>
        {masked ? <Text style={styles.masked}>{masked}</Text> : null}
        <Text style={styles.hint}>
          Adding a phone does not change your sign-in method or shop access. Management assignments stay the
          same.
        </Text>

        <Text style={styles.label}>Mobile number</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          style={styles.input}
          keyboardType="phone-pad"
          autoComplete="tel"
          placeholderTextColor="rgba(255,255,255,0.4)"
          placeholder="+1 555 555 0123"
          editable={!busy}
        />

        <GlowButton
          label={busy && step === "enter" ? "Sending…" : "Send Code"}
          onPress={onSend}
          loading={busy && step !== "code"}
          disabled={!canSend}
        />

        {step === "code" ? (
          <>
            <Text style={styles.label}>6-digit code</Text>
            <TextInput
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 8))}
              style={styles.input}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              placeholderTextColor="rgba(255,255,255,0.4)"
              placeholder="000000"
              maxLength={8}
              editable={!busy}
            />
            <GlowButton
              label="Verify"
              onPress={onVerify}
              loading={busy}
              disabled={!canVerify}
            />
          </>
        ) : null}

        {info ? <Text style={styles.info}>{info}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ProfileCard>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  status: { color: theme.colors.gold, fontSize: 16, fontWeight: "800" },
  masked: { color: theme.colors.textMuted, fontSize: 16 },
  hint: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  label: { color: theme.colors.gold, fontSize: 12, fontWeight: "800", letterSpacing: 1, marginTop: 4 },
  input: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.colors.text,
    fontSize: 16,
  },
  info: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 18 },
  error: { color: "#ff6b6b", fontSize: 13, lineHeight: 18 },
});
