import React, { useEffect, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import { useAuth } from "../../services/authContext";
import { patchProfile } from "../../services/profileApi";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";

function localAvatarKey(userId: string) {
  return `ifcdc_profile_avatar_${userId}`;
}

export default function EditProfileScreen() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [phone, setPhone] = useState(user?.phone || "");
  const [avatarUri, setAvatarUri] = useState<string | null>(user?.profileImageUrl || null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(user?.name || "");
    setPhone(user?.phone || "");
    setAvatarUri(user?.profileImageUrl || null);
    if (user?.id) {
      AsyncStorage.getItem(localAvatarKey(user.id)).then((uri) => {
        if (uri) setAvatarUri(uri);
      });
    }
  }, [user?.id, user?.name, user?.phone, user?.profileImageUrl]);

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photos", "Allow photo access to choose a profile picture.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      setAvatarUri(result.assets[0].uri);
    }
  };

  const onSave = async () => {
    if (!name.trim()) {
      Alert.alert("Name required", "Enter your display name.");
      return;
    }
    setSaving(true);
    try {
      if (user?.id && avatarUri && avatarUri.startsWith("file:")) {
        await AsyncStorage.setItem(localAvatarKey(user.id), avatarUri);
      }
      await patchProfile({
        name: name.trim(),
        phone: phone.replace(/\D/g, ""),
        profileImageUrl: avatarUri && !avatarUri.startsWith("file:") ? avatarUri : null,
      });
      await refresh();
      Alert.alert("Saved", "Your profile has been updated.");
    } catch (e) {
      Alert.alert("Save failed", userFacingApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileScreenLayout title="Edit Profile" subtitle="Update your account details">
      <ProfileCard style={styles.card}>
        <Pressable onPress={pickPhoto} style={styles.avatarTap}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarPlaceholderText}>+</Text>
            </View>
          )}
          <Text style={styles.changePhoto}>Change photo</Text>
        </Pressable>

        <Text style={styles.label}>Full name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          style={styles.input}
          placeholderTextColor="rgba(255,255,255,0.4)"
          placeholder="Your name"
        />

        <Text style={styles.label}>Phone</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          style={styles.input}
          keyboardType="phone-pad"
          placeholderTextColor="rgba(255,255,255,0.4)"
          placeholder="10-digit mobile number"
        />

        <Text style={styles.label}>Email</Text>
        <Text style={styles.readOnly}>{user?.email || "—"}</Text>
        <Text style={styles.hint}>Email is managed through sign-in and cannot be changed here.</Text>
      </ProfileCard>

      <GlowButton label="Save changes" onPress={onSave} loading={saving} disabled={saving} />
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  avatarTap: { alignItems: "center", marginBottom: 8 },
  avatar: { width: 88, height: 88, borderRadius: 44, borderWidth: 1, borderColor: theme.colors.borderGold },
  avatarPlaceholder: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    borderColor: theme.colors.borderGold,
    backgroundColor: theme.colors.bg1,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPlaceholderText: { color: theme.colors.gold, fontSize: 32, fontWeight: "300" },
  changePhoto: { color: theme.colors.gold, marginTop: 8, fontWeight: "700", fontSize: 14 },
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
  readOnly: { color: theme.colors.textMuted, fontSize: 16, paddingVertical: 4 },
  hint: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
});
