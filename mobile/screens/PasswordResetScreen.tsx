import React from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import IFCDCFooter from "../components/IFCDCFooter";
import { requestPasswordReset } from "../auth/authSessionApi";
import { userFacingApiError } from "../utils/userFacingApiError";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  navigation: { goBack: () => void };
};

export default function PasswordResetScreen({ navigation }: Props) {
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const onSubmit = React.useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed || !EMAIL_RE.test(trimmed)) {
      Alert.alert("Reset password", "Please enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      const message = await requestPasswordReset(trimmed);
      Alert.alert("Reset password", message);
    } catch (e) {
      Alert.alert("Reset password", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  }, [email]);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Reset password</Text>
      <Text style={styles.subtitle}>
        Enter your email and we'll send a link to set a new password on the IFCDC website.
      </Text>

      <View style={styles.card}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor="#666"
          style={styles.input}
          editable={!busy}
        />

        <Pressable
          onPress={() => void onSubmit()}
          disabled={busy}
          style={({ pressed }) => [
            styles.primary,
            busy ? styles.primaryDisabled : null,
            pressed && !busy ? styles.primaryPressed : null,
          ]}
        >
          <Text style={styles.primaryText}>{busy ? "Sending…" : "Send reset link"}</Text>
        </Pressable>

        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.secondary, pressed ? styles.secondaryPressed : null]}
        >
          <Text style={styles.secondaryText}>Back to sign in</Text>
        </Pressable>
      </View>
      <IFCDCFooter />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0b0b0b",
    padding: 24,
    paddingTop: 88,
    alignItems: "center",
  },
  title: {
    color: "#F5C842",
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  subtitle: {
    color: "#bdbdbd",
    fontSize: 13,
    textAlign: "center",
    maxWidth: 320,
    lineHeight: 18,
    marginBottom: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "rgba(245,200,66,0.04)",
    borderColor: "rgba(245,200,66,0.32)",
    borderWidth: 1,
    borderRadius: 12,
    padding: 18,
  },
  label: {
    color: "#F5C842",
    fontSize: 11,
    letterSpacing: 1.0,
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    backgroundColor: "#000",
    borderColor: "rgba(245,200,66,0.35)",
    borderWidth: 1,
    borderRadius: 8,
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 18,
  },
  primary: {
    backgroundColor: "#F5C842",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryPressed: {
    opacity: 0.85,
  },
  primaryDisabled: {
    opacity: 0.5,
  },
  primaryText: {
    color: "#0b0b0b",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  secondary: {
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryPressed: {
    opacity: 0.7,
  },
  secondaryText: {
    color: "#F5C842",
    fontSize: 13,
    fontWeight: "700",
  },
});
