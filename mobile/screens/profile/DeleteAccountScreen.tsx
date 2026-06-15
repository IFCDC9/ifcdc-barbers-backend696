import React from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import IFCDCInput from "../../components/IFCDCInput";
import { theme } from "../../constants/theme";
import { useAuth } from "../../services/authContext";
import { deleteMyAccount } from "../../auth/authSessionApi";
import { userFacingApiError } from "../../utils/userFacingApiError";

const CONFIRM_PHRASE = "DELETE";

export default function DeleteAccountScreen() {
  const { t } = useTranslation();
  const { token, user, signOut } = useAuth();
  const [confirmText, setConfirmText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const canDelete = confirmText.trim().toUpperCase() === CONFIRM_PHRASE && !busy;

  const runDelete = () => {
    if (!token) {
      Alert.alert(t("profile.deleteAccountTitle"), t("profile.deleteAccountSignInRequired"));
      return;
    }
    Alert.alert(t("profile.deleteAccountConfirmTitle"), t("profile.deleteAccountConfirmBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("profile.deleteAccountAction"),
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await deleteMyAccount(token);
            await signOut();
            Alert.alert(t("profile.deleteAccountDoneTitle"), t("profile.deleteAccountDoneBody"));
          } catch (e) {
            Alert.alert(t("profile.deleteAccountTitle"), userFacingApiError(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <ProfileScreenLayout
      title={t("profile.deleteAccountTitle")}
      subtitle={t("profile.deleteAccountSubtitle")}
    >
      <ProfileCard>
        <Text style={styles.warning}>{t("profile.deleteAccountWarning")}</Text>
        <Text style={styles.bullet}>• {t("profile.deleteAccountBulletProfile")}</Text>
        <Text style={styles.bullet}>• {t("profile.deleteAccountBulletBookings")}</Text>
        <Text style={styles.bullet}>• {t("profile.deleteAccountBulletSignIn")}</Text>
        {user?.email ? (
          <Text style={styles.accountEmail}>
            {t("profile.deleteAccountEmailLabel")}: {user.email}
          </Text>
        ) : null}
      </ProfileCard>

      <ProfileCard>
        <Text style={styles.confirmLabel}>{t("profile.deleteAccountTypeConfirm")}</Text>
        <IFCDCInput
          value={confirmText}
          onChangeText={setConfirmText}
          placeholder={CONFIRM_PHRASE}
          autoCapitalize="characters"
          editable={!busy}
        />
        <View style={{ height: 14 }} />
        <GlowButton
          label={t("profile.deleteAccountAction")}
          onPress={runDelete}
          disabled={!canDelete}
          loading={busy}
        />
        <Pressable onPress={() => setConfirmText("")} disabled={busy} style={styles.clearLink}>
          <Text style={styles.clearText}>{t("common.cancel")}</Text>
        </Pressable>
      </ProfileCard>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  warning: {
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
    fontWeight: "600",
  },
  bullet: {
    color: theme.colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 6,
  },
  accountEmail: {
    marginTop: 12,
    color: theme.colors.gold,
    fontSize: 13,
    fontWeight: "700",
  },
  confirmLabel: {
    color: theme.colors.textMuted,
    fontSize: 13,
    marginBottom: 10,
    lineHeight: 19,
  },
  clearLink: { marginTop: 14, alignItems: "center" },
  clearText: { color: theme.colors.textMuted, fontSize: 14, fontWeight: "600" },
});
