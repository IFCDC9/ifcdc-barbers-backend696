import React from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Constants from "expo-constants";
import * as Google from "expo-auth-session/providers/google";
import { useTranslation } from "react-i18next";
import CardContainer from "../components/CardContainer";
import IFCDCFooter from "../components/IFCDCFooter";
import GlowButton from "../components/GlowButton";
import GoogleButton from "../components/GoogleButton";
import LanguageDropdown from "../components/LanguageDropdown";
import ProviderTypeDropdown, { type AccountSelection } from "../components/ProviderTypeDropdown";
import { theme } from "../constants/theme";
import { BACKEND_URL, apiFullUrl } from "../constants/config";
import { useAuth } from "../services/authContext";
import { EXPO_GO_GOOGLE_PROMPT_OPTIONS } from "../auth/expoGooglePromptOptions";
import { getGoogleIdTokenAuthConfig } from "../auth/googleAuthRequestConfig";
import { exchangeGoogleIdToken } from "../auth/googleBackendLogin";
import { registerWithEmailPassword, type RegisterAccountType } from "../auth/authSessionApi";
import { UX } from "../utils/uxCopy";
import { userFacingApiError } from "../utils/userFacingApiError";
import { validateSignupPhone } from "../utils/phoneValidation";
import { POLICY_VERSION } from "../constants/legalContent";
import { buildSignupAcceptances, recordAcceptance } from "../services/legalApi";
import {
  currentLanguage,
  setLanguage,
  type SupportedLanguageCode,
} from "../i18n";

function appVersionString(): string {
  return (
    (Constants.expoConfig as { version?: string } | undefined)?.version ||
    (Constants.manifest as unknown as { version?: string } | undefined)?.version ||
    ""
  );
}

// expo-auth-session v7+ redirect options are inferred by the provider.
const GOOGLE_REDIRECT_OPTIONS = undefined;

export default function RegisterScreen({ navigation }: { navigation: any }) {
  const { t, i18n } = useTranslation();
  React.useEffect(() => {
    console.log("[register] API base:", BACKEND_URL, "register URL:", apiFullUrl("/api/auth/register"));
  }, []);
  const { signInWithToken } = useAuth();
  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [accountSelection, setAccountSelection] = React.useState<AccountSelection>("customer");
  const isShopOwner = accountSelection === "shop_owner";
  const needsShopFields = accountSelection !== "customer";
  const accountTypeForApi: RegisterAccountType =
    accountSelection === "customer"
      ? "customer"
      : accountSelection === "shop_owner"
        ? "shop_owner"
        : "barber";
  const [phone, setPhone] = React.useState("");
  const [shopName, setShopName] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [city, setCity] = React.useState("");
  const [stateProv, setStateProv] = React.useState("");
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = React.useState(false);
  const [acceptedNotifications, setAcceptedNotifications] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const submittingRef = React.useRef(false);

  // Pre-signup language selector. Persisted to AsyncStorage immediately on tap so
  // every subsequent screen + the registration payload reflect the user's choice.
  const [activeLang, setActiveLang] = React.useState<SupportedLanguageCode>(currentLanguage());
  React.useEffect(() => {
    const onChanged = () => setActiveLang(currentLanguage());
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, [i18n]);

  const googleAuthConfig = React.useMemo(() => getGoogleIdTokenAuthConfig(), []);
  const googleConfigured = Boolean(
    googleAuthConfig.webClientId?.endsWith(".apps.googleusercontent.com")
  );

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest(googleAuthConfig);

  React.useEffect(() => {
    if (request?.redirectUri) {
      console.log("[auth] redirectUri", request.redirectUri);
    }
    console.log("[auth] Google request ready:", Boolean(request));
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

      if (!acceptedTerms || !acceptedPrivacy) {
        Alert.alert(
          "Required acceptance",
          "Please review and accept the Terms & Conditions and the Privacy Policy before continuing with Google.",
        );
        return undefined;
      }

      const ac = new AbortController();
      (async () => {
        try {
          setBusy(true);
          const responseData = await exchangeGoogleIdToken(BACKEND_URL, idToken, ac.signal);
          const wrapped = { data: responseData };
          console.log("GOOGLE RESPONSE:", wrapped.data);

          if (responseData.token) {
            try {
              const u = responseData.user;
              console.log("[auth] client_google_register", {
                email: u?.email,
                role: u?.role,
                redirect: responseData.redirect,
              });
              await signInWithToken(responseData.token);
              try {
                const acceptances = buildSignupAcceptances({
                  acceptedTerms,
                  acceptedPrivacy,
                  acceptedNotifications,
                });
                void recordAcceptance(acceptances);
              } catch (legalErr) {
                if (__DEV__) {
                  console.log(
                    "[register] post-google legal record failed:",
                    legalErr instanceof Error ? legalErr.message : String(legalErr),
                  );
                }
              }
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
          console.log("[register] Google exchange failed:", e instanceof Error ? e.message : String(e));
          Alert.alert("Google sign-in", userFacingApiError(e));
        } finally {
          if (!ac.signal.aborted) setBusy(false);
        }
      })();
      return () => ac.abort();
    } catch (e) {
      console.log("[register] Google response handler error:", e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }, [response, signInWithToken, acceptedTerms, acceptedPrivacy, acceptedNotifications]);

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

  const register = async () => {
    if (submittingRef.current) return;
    if (!acceptedTerms || !acceptedPrivacy) {
      Alert.alert(
        t("auth.consentRequiredTitle"),
        t("auth.consentRequiredBody"),
      );
      return;
    }
    const phoneCheck = validateSignupPhone(phone);
    if (!phoneCheck.ok) {
      Alert.alert("Create account", phoneCheck.message);
      return;
    }
    submittingRef.current = true;
    try {
      setBusy(true);
      const acceptances = buildSignupAcceptances({
        acceptedTerms,
        acceptedPrivacy,
        acceptedNotifications,
      });
      const profileExtras =
        accountSelection !== "customer"
          ? isShopOwner
            ? {
                phone: phoneCheck.display,
                businessName: shopName.trim(),
                address: address.trim(),
                city: city.trim(),
                state: stateProv.trim(),
              }
            : {
                phone: phoneCheck.display,
                shopName: shopName.trim(),
                address: address.trim(),
                city: city.trim(),
                state: stateProv.trim(),
              }
          : { phone: phoneCheck.display };
      const { token, json } = await registerWithEmailPassword(
        fullName.trim(),
        email.trim(),
        password,
        accountTypeForApi,
        {
          acceptances,
          appVersion: appVersionString(),
          platform: Platform.OS,
          language: activeLang,
          providerType: accountSelection !== "customer" ? accountSelection : undefined,
          ...profileExtras,
        },
      );
      const u = json?.user;
      console.log("[auth] client_register", {
        email: u?.email,
        role: u?.role,
        redirect: json?.redirect,
      });
      try {
        await signInWithToken(token);
      } catch (saveErr) {
        Alert.alert("Session", userFacingApiError(saveErr));
      }
      if (json?.approvalPending || u?.limitedAccess) {
        Alert.alert(
          "Pending approval",
          String(
            (u as { message?: string })?.message ||
              "Your account was created and is pending Super Admin approval. You will receive full access once approved.",
          ),
        );
      }
    } catch (e) {
      Alert.alert("Create account", userFacingApiError(e));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View pointerEvents="none" style={styles.glowOrb} />
      <Text style={styles.brand}>IFCDC BARBER</Text>
      <View style={styles.brandUnderline} />
      <Text style={styles.title}>{t("auth.signUpTitle")}</Text>
      <Text style={styles.tagline}>{t("auth.signUpTagline")}</Text>

      <CardContainer glow style={{ width: "100%", marginBottom: 12 }}>
        <LanguageDropdown
          label={t("auth.chooseLanguage")}
          hint={t("auth.chooseLanguageHint")}
          value={activeLang}
          disabled={busy}
          onChange={async (code) => {
            await setLanguage(code);
            setActiveLang(code);
          }}
        />
      </CardContainer>

      <CardContainer glow style={{ width: "100%" }}>
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

        <TextInput
          value={fullName}
          onChangeText={setFullName}
          placeholder={t("auth.fullName")}
          placeholderTextColor="rgba(255,255,255,0.45)"
          style={styles.input}
          editable={!busy}
        />
        <View style={{ height: 10 }} />
        <Text style={styles.helper}>{t("auth.accountType")}</Text>
        <View style={{ height: 8 }} />
        <ProviderTypeDropdown
          value={accountSelection}
          onChange={setAccountSelection}
          disabled={busy}
        />
        <View style={{ height: 10 }} />
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder={t("auth.phoneRequired")}
          placeholderTextColor="rgba(255,255,255,0.45)"
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          style={styles.input}
          editable={!busy}
        />
        {needsShopFields ? (
          <>
            <View style={{ height: 10 }} />
            <TextInput
              value={shopName}
              onChangeText={setShopName}
              placeholder={isShopOwner ? "Shop name" : "Shop name or assigned shop"}
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.input}
              editable={!busy}
            />
            <View style={{ height: 10 }} />
            <TextInput
              value={address}
              onChangeText={setAddress}
              placeholder={isShopOwner ? "Shop address" : "Location / address"}
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.input}
              editable={!busy}
            />
            <View style={{ height: 10 }} />
            <View style={styles.roleRow}>
              <TextInput
                value={city}
                onChangeText={setCity}
                placeholder="City"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                editable={!busy}
              />
              <View style={{ width: 10 }} />
              <TextInput
                value={stateProv}
                onChangeText={setStateProv}
                placeholder="State"
                placeholderTextColor="rgba(255,255,255,0.45)"
                autoCapitalize="characters"
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                editable={!busy}
              />
            </View>
          </>
        ) : null}
        <View style={{ height: 10 }} />
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder={t("auth.email")}
          placeholderTextColor="rgba(255,255,255,0.45)"
          autoCapitalize="none"
          keyboardType="email-address"
          style={styles.input}
          editable={!busy}
        />
        <View style={{ height: 10 }} />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder={t("auth.password")}
          placeholderTextColor="rgba(255,255,255,0.45)"
          secureTextEntry
          style={styles.input}
          editable={!busy}
        />
        <View style={{ height: 16 }} />
        <View style={styles.legalBlock}>
          <ConsentRow
            checked={acceptedTerms}
            onToggle={() => setAcceptedTerms(v => !v)}
            disabled={busy}
            required
          >
            {t("auth.consentTermsBefore")}
            <Text
              style={styles.legalLink}
              onPress={() => navigation.navigate("TermsConditions")}
            >
              {t("auth.consentTermsLink")}
            </Text>
            .
          </ConsentRow>
          <View style={{ height: 8 }} />
          <ConsentRow
            checked={acceptedPrivacy}
            onToggle={() => setAcceptedPrivacy(v => !v)}
            disabled={busy}
            required
          >
            {t("auth.consentPrivacyBefore")}
            <Text
              style={styles.legalLink}
              onPress={() => navigation.navigate("PrivacyPolicy")}
            >
              {t("auth.consentPrivacyLink")}
            </Text>
            .
          </ConsentRow>
          <View style={{ height: 8 }} />
          <ConsentRow
            checked={acceptedNotifications}
            onToggle={() => setAcceptedNotifications(v => !v)}
            disabled={busy}
          >
            {t("auth.consentNotifications")}
          </ConsentRow>
          <Text style={styles.policyVersion}>
            {t("auth.policyVersion", { version: POLICY_VERSION })}
          </Text>
        </View>
        <View style={{ height: 12 }} />
        <GlowButton label={t("auth.signUpBtn")} onPress={register} disabled={busy} loading={busy} />

        <View style={{ height: 12 }} />
        <GlowButton
          label={t("auth.backToSignIn")}
          onPress={() => navigation.navigate("Login")}
          variant="outline"
          disabled={busy}
        />
      </CardContainer>
      <IFCDCFooter />
    </ScrollView>
  );
}

function ConsentRow({
  checked,
  onToggle,
  disabled = false,
  required = false,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.consentRow,
        pressed && !disabled && styles.consentRowPressed,
      ]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
    >
      <View
        style={[
          styles.checkbox,
          checked && styles.checkboxChecked,
          disabled && styles.checkboxDisabled,
        ]}
      >
        {checked ? <Text style={styles.checkboxMark}>✓</Text> : null}
      </View>
      <View style={styles.consentTextWrap}>
        <Text style={styles.consentText}>{children}</Text>
        {required ? <Text style={styles.consentRequired}>Required</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: theme.colors.bg0 },
  container: {
    flexGrow: 1,
    backgroundColor: theme.colors.bg0,
    padding: 20,
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    paddingVertical: 36,
  },
  glowOrb: {
    position: "absolute",
    top: 0,
    left: "50%",
    marginLeft: -160,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: "rgba(245,200,66,0.06)",
  },
  brand: { color: theme.colors.gold, fontWeight: "900", fontSize: 18, letterSpacing: 1.8 },
  brandUnderline: {
    width: 28,
    height: 2,
    borderRadius: 2,
    backgroundColor: theme.colors.goldSoft,
    marginTop: 4,
    marginBottom: 6,
  },
  title: { color: theme.colors.text, fontWeight: "900", fontSize: 28, marginTop: 4 },
  tagline: {
    color: theme.colors.textMuted,
    fontSize: 12.5,
    marginBottom: 14,
    letterSpacing: 0.4,
  },
  helper: { color: theme.colors.textMuted, textAlign: "center", fontSize: 12 },
  or: { color: theme.colors.textMuted, textAlign: "center", fontWeight: "700" },
  roleRow: { flexDirection: "row", width: "100%", justifyContent: "center", alignItems: "stretch" },
  langRow: { flexDirection: "row", width: "100%", justifyContent: "center", gap: 10 },
  langPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  langPillSelected: {
    borderColor: theme.colors.gold,
    backgroundColor: "rgba(245,200,66,0.12)",
  },
  langPillPressed: { opacity: 0.7 },
  langPillText: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  langPillTextSelected: { color: theme.colors.gold },
  langPillCode: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  langHint: { marginTop: 10, fontSize: 11.5 },
  input: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.colors.text,
    fontSize: 14.5,
  },
  legalBlock: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: theme.radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  legalLink: { color: theme.colors.gold, fontWeight: "700", textDecorationLine: "underline" },
  policyVersion: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 10,
    letterSpacing: 0.4,
  },
  consentRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  consentRowPressed: { opacity: 0.7 },
  consentTextWrap: { flex: 1 },
  consentText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
  consentRequired: {
    color: theme.colors.gold,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginTop: 3,
    textTransform: "uppercase",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "rgba(245,200,66,0.55)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: "rgba(245,200,66,0.2)",
    borderColor: theme.colors.gold,
  },
  checkboxDisabled: { opacity: 0.5 },
  checkboxMark: {
    color: theme.colors.gold,
    fontSize: 14,
    lineHeight: 14,
    fontWeight: "900",
  },
});
