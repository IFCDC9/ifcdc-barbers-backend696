import React, { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import LanguageDropdown from "../../components/LanguageDropdown";
import { theme } from "../../constants/theme";
import {
  SUPPORTED_LANGUAGES,
  currentLanguage,
  detectDeviceLanguage,
  resetToDeviceLanguage,
  setLanguage,
  type SupportedLanguageCode,
} from "../../i18n";

export default function LanguageSettingsScreen() {
  const { t, i18n } = useTranslation();
  const [active, setActive] = useState<SupportedLanguageCode>(currentLanguage());
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    const onChanged = (lng: string) => {
      const next = lng as SupportedLanguageCode;
      setActive(currentLanguage() === next ? next : currentLanguage());
    };
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, [i18n]);

  const deviceLang = useMemo(() => detectDeviceLanguage(), []);
  const deviceMeta = SUPPORTED_LANGUAGES.find((l) => l.code === deviceLang);
  const activeMeta = SUPPORTED_LANGUAGES.find((l) => l.code === active);

  const choose = async (code: SupportedLanguageCode) => {
    if (busy || code === active) return;
    setBusy(true);
    try {
      await setLanguage(code);
      setActive(code);
    } finally {
      setBusy(false);
    }
  };

  const useDevice = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await resetToDeviceLanguage();
      setActive(next);
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
          label={t("language.select", { defaultValue: "Select language" })}
          value={active}
          disabled={busy}
          onChange={choose}
        />
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
  listCard: { paddingVertical: 18 },
  deviceCard: { marginBottom: 24 },
});
