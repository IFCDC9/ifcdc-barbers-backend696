import React, { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import LanguageDropdown from "../../components/LanguageDropdown";
import { theme } from "../../constants/theme";
import {
  getPickerLanguages,
  languageMeta,
  currentLanguage,
  detectDeviceLanguage,
  resetToDeviceLanguage,
  setLanguage,
  type SupportedLanguageCode,
} from "../../i18n";
import { patchProfile } from "../../services/profileApi";
import { useAuth } from "../../services/authContext";

export default function LanguageSettingsScreen() {
  const { t, i18n } = useTranslation();
  const { user, token } = useAuth();
  const [active, setActive] = useState<SupportedLanguageCode>(currentLanguage());
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  React.useEffect(() => {
    const onChanged = () => setActive(currentLanguage());
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, [i18n]);

  const deviceLang = useMemo(() => detectDeviceLanguage(), []);
  const deviceMeta = languageMeta(deviceLang);
  const activeMeta = languageMeta(active);
  const pickerCount = getPickerLanguages().length;

  const persistServer = async (code: SupportedLanguageCode) => {
    if (!token || !user) return;
    try {
      await patchProfile({ preferredLanguage: code, language: code });
    } catch {
      /* local preference still saved */
    }
  };

  const choose = async (code: SupportedLanguageCode) => {
    if (busy || code === active) return;
    setBusy(true);
    setSavedMsg("");
    try {
      await setLanguage(code);
      setActive(code);
      await persistServer(code);
      setSavedMsg(t("language.saved"));
    } finally {
      setBusy(false);
    }
  };

  const useDevice = async () => {
    if (busy) return;
    setBusy(true);
    setSavedMsg("");
    try {
      const next = await resetToDeviceLanguage();
      setActive(next);
      await persistServer(next);
      setSavedMsg(t("language.saved"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProfileScreenLayout
      title={t("language.title")}
      subtitle={t("language.subtitle")}
      headerTopPad={12}
    >
      <ProfileCard style={styles.summaryCard}>
        <Text style={styles.eyebrow}>{t("profile.menuLanguage")}</Text>
        <Text style={styles.summaryText}>
          {t("language.current", { name: activeMeta?.nativeName ?? active })}
        </Text>
        {deviceMeta ? (
          <Text style={styles.summaryHint}>
            {t("language.deviceDetected", { name: deviceMeta.nativeName })}
          </Text>
        ) : null}
      </ProfileCard>

      <ProfileCard style={styles.listCard}>
        <LanguageDropdown
          label={t("language.title")}
          value={active}
          disabled={busy}
          onChange={choose}
          hint={
            pickerCount > 2
              ? undefined
              : t("language.chooseLanguageHint", {
                  defaultValue: "You can change this later in Profile.",
                })
          }
        />
        {savedMsg ? <Text style={styles.saved}>{savedMsg}</Text> : null}
      </ProfileCard>

      <ProfileCard style={styles.deviceCard}>
        <GlowButton
          label={t("language.useDevice")}
          variant="outline"
          onPress={useDevice}
          disabled={busy}
        />
      </ProfileCard>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  summaryCard: { gap: 6, paddingVertical: 18 },
  eyebrow: {
    color: theme.colors.gold,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  summaryText: { color: theme.colors.text, fontSize: 16, fontWeight: "700" },
  summaryHint: { color: theme.colors.textMuted, fontSize: 13, marginTop: 4 },
  listCard: { paddingVertical: 18, gap: 8 },
  saved: { color: theme.colors.gold, fontSize: 13, marginTop: 8 },
  deviceCard: { marginBottom: 24 },
});
