import React from "react";
import { Alert, Platform, StyleSheet, Text, View } from "react-native";
import * as Google from "expo-auth-session/providers/google";
import { useTranslation } from "react-i18next";
import CardContainer from "../components/CardContainer";
import GlowButton from "../components/GlowButton";
import GoogleButton from "../components/GoogleButton";
import AppleSignInButton, {
  isAppleSignInAvailable,
  requestAppleCredential,
} from "../components/AppleSignInButton";
import IFCDCInput from "../components/IFCDCInput";
import IFCDCFooter from "../components/IFCDCFooter";
import { palette, radius, typography } from "../constants/theme";
import { BACKEND_URL, apiFullUrl } from "../constants/config";
import { useAuth } from "../services/authContext";
import { EXPO_GO_GOOGLE_PROMPT_OPTIONS } from "../auth/expoGooglePromptOptions";
import { getGoogleIdTokenAuthConfig } from "../auth/googleAuthRequestConfig";
import { exchangeGoogleIdToken } from "../auth/googleBackendLogin";
import { exchangeAppleIdentityToken } from "../auth/appleBackendLogin";
import LanguageDropdown from "../components/LanguageDropdown";
import { currentLanguage, setLanguage, type SupportedLanguageCode } from "../i18n";
import { loginWithEmailPassword } from "../auth/authSessionApi";
import { userFacingApiError } from "../utils/userFacingApiError";
import { UX } from "../utils/uxCopy";

// expo-auth-session v7+ redirect options are inferred by the provider.
const GOOGLE_REDIRECT_OPTIONS = undefined;

export default function LoginScreen({ navigation }: { navigation: any }) {
  const { t } = useTranslation();
  React.useEffect(() => {
    console.log("[login] API base:", BACKEND_URL, "login URL:", apiFullUrl("/api/auth/login"));
  }, []);

  const { signInWithToken } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [verificationCode, setVerificationCode] = React.useState("");
  const [needsVerification, setNeedsVerification] = React.useState(false);
  const [verificationHint, setVerificationHint] = React.useState("");
  const [lang, setLang] = React.useState<SupportedLanguageCode>(currentLanguage());
  const [busy, setBusy] = React.useState(false);
  const [appleAvailable, setAppleAvailable] = React.useState(false);
  const submittingRef = React.useRef(false);

  React.useEffect(() => {
    if (Platform.OS !== "ios") return;
    isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const googleAuthConfig = React.useMemo(() => getGoogleIdTokenAuthConfig(), []);
  const googleConfigured = Boolean(
    googleAuthConfig.webClientId?.endsWith(".apps.googleusercontent.com")
  );

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest(googleAuthConfig);

  React.useEffect(() => {
    try {
      if (request?.redirectUri) {
        console.log("[auth] redirectUri", request.redirectUri);
      }
      console.log("[auth] Google request ready:", Boolean(request));
    } catch (e) {
      console.log("CRASH:", e);
    }
  }, [request]);

  React.useEffect(() => {
    if (!response) return undefined;

    try {
      const p = (response as any).params || {};
      console.log("[auth] Google response:", response.type, { hasIdToken: Boolean(p.id_token) });

      if (response.type === "error") {
        Alert.alert("Google sign-in", "Google sign-in could not be completed. Please try again.");
        return undefined;
      }

      if (response.type === "dismiss" || response.type === "cancel") {
        return undefined;
      }

      if (response.type !== "success") return undefined;

      const idToken =
        (p.id_token as string | undefined)
        || ((response as any)?.authentication?.idToken as string | undefined);

      if (!idToken) {
        Alert.alert("Google sign-in", "Google sign-in could not be completed. Please try again.");
        return undefined;
      }

      const ac = new AbortController();
      (async () => {
        try {
          setBusy(true);
          const responseData = await exchangeGoogleIdToken(BACKEND_URL, idToken, ac.signal);
          const wrapped = { data: responseData };
          if (__DEV__) console.log("[auth] Google login response ok");

          if (responseData.token) {
            try {
              const u = responseData.user;
              console.log("[auth] client_google_login", {
                email: u?.email,
                role: u?.role,
                redirect: responseData.redirect,
              });
              await signInWithToken(responseData.token);
            } catch (saveErr) {
              Alert.alert("Session", userFacingApiError(saveErr));
            }
            return;
          }

          if (responseData.user) {
            Alert.alert("Google sign-in", "Sign-in could not be completed. Please try again or use email.");
            return;
          }

          Alert.alert("Google sign-in", "Sign-in could not be completed. Please try again.");
        } catch (e) {
          if ((e as Error)?.name === "AbortError") return;
          console.log("CRASH:", e);
          console.log("[login] Google exchange failed:", e instanceof Error ? e.message : String(e));
          Alert.alert("Google sign-in", userFacingApiError(e));
        } finally {
          if (!ac.signal.aborted) setBusy(false);
        }
      })();
      return () => ac.abort();
    } catch (e) {
      console.log("CRASH:", e);
      console.log("[login] Google response handler error:", e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }, [response, signInWithToken]);

  const startApple = async () => {
    if (!appleAvailable) {
      Alert.alert(t("auth.appleSignIn"), t("auth.appleSignInUnavailable"));
      return;
    }
    try {
      setBusy(true);
      const credential = await requestAppleCredential();
      const responseData = await exchangeAppleIdentityToken(BACKEND_URL, credential.identityToken, {
        email: credential.email,
        fullName: credential.fullName,
      });
      if (responseData.token) {
        await signInWithToken(responseData.token);
        return;
      }
      Alert.alert(t("auth.appleSignIn"), t("auth.appleSignInFailed"));
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "ERR_REQUEST_CANCELED") return;
      Alert.alert(t("auth.appleSignIn"), userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const startGoogle = async () => {
    if (!googleConfigured) {
      Alert.alert("Google sign-in", UX.googleSignInUnavailable);
      return;
    }
    if (!request) {
      Alert.alert("Google sign-in", "Google is still initializing. Wait a moment and try again.");
      return;
    }
    try {
      const result = await promptAsync(EXPO_GO_GOOGLE_PROMPT_OPTIONS);
      console.log("[auth] promptAsync done:", result.type);
    } catch (e) {
      console.log("[auth] promptAsync error:", e instanceof Error ? e.message : String(e));
      Alert.alert("Google sign-in", userFacingApiError(e));
    }
  };

  const login = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      setBusy(true);
      const codeInput = verificationCode.trim();
      if (needsVerification && !codeInput) {
        Alert.alert("Sign in", "Enter the verification code from your text message.");
        return;
      }
      const submittedCode = needsVerification ? codeInput : undefined;
      const result = await loginWithEmailPassword(email.trim(), password, submittedCode);
      if (result.requiresVerification) {
        setNeedsVerification(true);
        const rawMsg = String(result.json?.message || "").trim();
        const err = String(result.json?.error || "");
        const smsAccepted =
          result.json?.smsAccepted === true || (result.json as { smsAccepted?: boolean })?.smsAccepted === true;
        const smsFailed =
          result.json?.smsAccepted === false ||
          (result.json as { smsAccepted?: boolean })?.smsAccepted === false ||
          /couldn.?t send|could not send|sms_start_failed|sms_phone_unconfigured/i.test(
            `${err} ${rawMsg}`,
          );
        // If we already submitted a code, do not treat this as a fresh "code sent" success.
        if (submittedCode) {
          const msg =
            rawMsg ||
            "That verification code wasn’t accepted. Check the latest text and try again.";
          setVerificationHint(msg);
          Alert.alert("Sign in", msg);
          return;
        }
        setVerificationHint(
          !smsAccepted || smsFailed
            ? "We couldn’t send your verification code. Please try again."
            : t("auth.codeSentSms", { defaultValue: "Verification code sent by text." }),
        );
        return;
      }
      if (!result.token) {
        Alert.alert("Sign in", "Sign-in succeeded but no session token was returned. Please try again.");
        return;
      }
      const u = result.json?.user;
      console.log("[auth] client_login", {
        email: u?.email,
        role: u?.role,
        isOwner: u?.isOwner,
        isSuperAdmin: u?.isSuperAdmin,
        redirect: result.json?.redirect,
      });
      try {
        await signInWithToken(result.token);
        setNeedsVerification(false);
        setVerificationCode("");
        setVerificationHint("");
      } catch (saveErr) {
        Alert.alert("Session", userFacingApiError(saveErr));
      }
    } catch (e) {
      Alert.alert("Sign in", userFacingApiError(e));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <View pointerEvents="none" style={styles.glowOrb} />
      <View style={styles.main}>
      <Text style={styles.brand}>IFCDC BARBER</Text>
      <View style={styles.brandUnderline} />
      <Text style={styles.title}>{t("auth.signInTitle")}</Text>
      <Text style={styles.tagline}>{t("auth.signInTagline")}</Text>

      <CardContainer glow style={{ width: "100%" }}>
        {appleAvailable ? (
          <>
            <AppleSignInButton onPress={startApple} disabled={busy} />
            <View style={{ height: 12 }} />
          </>
        ) : null}

        {googleConfigured && request ? (
          <>
            <GoogleButton onPress={startGoogle} disabled={!request || busy} />
            <View style={{ height: 12 }} />
            <Text style={styles.or}>{t("auth.or")}</Text>
            <View style={{ height: 12 }} />
          </>
        ) : googleConfigured ? (
          <>
            <Text style={styles.helper}>Preparing Google sign-in…</Text>
            <View style={{ height: 12 }} />
          </>
        ) : (
          <>
            <Text style={styles.helper}>{UX.googleSignInUnavailable}</Text>
            <View style={{ height: 12 }} />
          </>
        )}

        <IFCDCInput
          value={email}
          onChangeText={setEmail}
          placeholder={t("auth.email")}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!busy}
        />
        <View style={{ height: 10 }} />
        <IFCDCInput
          value={password}
          onChangeText={setPassword}
          placeholder={t("auth.password")}
          secureTextEntry
          editable={!busy}
        />
        {needsVerification ? (
          <>
            <View style={{ height: 10 }} />
            <Text style={styles.helper}>{verificationHint || "Enter verification code"}</Text>
            <View style={{ height: 8 }} />
            <IFCDCInput
              value={verificationCode}
              onChangeText={setVerificationCode}
              placeholder="Verification code"
              autoCapitalize="none"
              keyboardType="number-pad"
              editable={!busy}
            />
          </>
        ) : null}
        <View style={{ height: 12 }} />
        <LanguageDropdown
          label={t("language.title")}
          value={lang}
          disabled={busy}
          onChange={async (code) => {
            setLang(code);
            await setLanguage(code);
          }}
        />
        <View style={{ height: 12 }} />
        <GlowButton label={t("auth.signInBtn")} onPress={login} disabled={busy} loading={busy} />

        <View style={{ height: 12 }} />
        <GlowButton
          label={t("auth.signUpBtn")}
          onPress={() => navigation.navigate("Register")}
          variant="outline"
          disabled={busy}
        />
      </CardContainer>
      </View>
      <IFCDCFooter />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.bg0,
    padding: 20,
    paddingBottom: 12,
  },
  main: {
    flex: 1,
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },
  glowOrb: {
    position: "absolute",
    top: -120,
    left: "50%",
    marginLeft: -160,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: "rgba(212,175,55,0.06)",
  },
  brand: { ...typography.brand },
  brandUnderline: {
    width: 28,
    height: 2,
    borderRadius: 2,
    backgroundColor: palette.goldHigh,
    marginTop: 4,
    marginBottom: 6,
  },
  title: { ...typography.display, marginTop: 4 },
  tagline: {
    ...typography.bodyMuted,
    fontSize: 12.5,
    marginBottom: 14,
    letterSpacing: 0.4,
  },
  helper: { ...typography.caption, textAlign: "center" },
  or: { ...typography.caption, textAlign: "center", fontWeight: "700", letterSpacing: 1.6 },
});
