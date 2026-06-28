import React, { useCallback, useEffect, useState } from "react";
import { Alert, Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import StaffRosterGuard from "../../components/StaffRosterGuard";
import {
  fetchBarberProfile,
  saveBarberProfile,
  uploadBarberServiceImage,
} from "../../services/barberStaffApi";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { ScreenLoading } from "../../components/LoadingState";
import { theme } from "../../constants/theme";
import { compressReviewPhoto } from "../../utils/compressReviewPhoto";
import type { BarberDetailParams } from "./BarberDetailScreen";

type EditRoute = RouteProp<{ BarberEdit: BarberDetailParams }, "BarberEdit">;

function BarberEditInner() {
  const navigation = useNavigation();
  const route = useRoute<EditRoute>();
  const { barberId, barberName } = route.params;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(barberName);
  const [phone, setPhone] = useState("");
  const [bio, setBio] = useState("");
  const [location, setLocation] = useState("");
  const [shopName, setShopName] = useState("");
  const [headline, setHeadline] = useState("");
  const [yearsExperience, setYearsExperience] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [coverImage, setCoverImage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await fetchBarberProfile(barberId);
      if (p) {
        setName(p.name || barberName);
        setPhone(p.phone || p.business_phone || "");
        setBio(p.bio || "");
        setLocation(typeof p.location === "string" ? p.location : "");
        setShopName(p.shop_name || p.business_name || "");
        setHeadline(p.portfolio_headline || "");
        setYearsExperience(p.years_experience != null && p.years_experience > 0 ? String(p.years_experience) : "");
        setAddress(p.business_address || "");
        setCity(p.business_city || "");
        setState(p.business_state || "");
        setProfileImage(p.profile_image || null);
        setCoverImage(p.logo || null);
      }
    } finally {
      setLoading(false);
    }
  }, [barberId, barberName]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickImage = async (slot: "profile" | "cover") => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Allow photo access to update your profile.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setSaving(true);
    try {
      const uri = await compressReviewPhoto(result.assets[0].uri);
      const url = await uploadBarberServiceImage(barberId, uri);
      if (slot === "profile") setProfileImage(url);
      else setCoverImage(url);
    } catch (e) {
      Alert.alert("Upload failed", userFacingApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await saveBarberProfile(barberId, {
        name,
        phone,
        bio,
        location,
        shop_name: shopName,
        portfolio_headline: headline,
        years_experience: yearsExperience.trim() ? Number(yearsExperience) : null,
        business_address: address,
        business_city: city,
        business_state: state,
        profile_image: profileImage || undefined,
        logo: coverImage || undefined,
      });
      Alert.alert("Saved", "Your profile is updated everywhere in the app.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert("Save failed", userFacingApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileScreenLayout title="Edit profile" subtitle={barberName}>
      {loading ? <ScreenLoading /> : null}
      {!loading ? (
        <ScrollView contentContainerStyle={styles.scroll}>
          <ProfileCard style={styles.form}>
            <Text style={styles.sectionLabel}>Photos</Text>
            <View style={styles.photoRow}>
              <View style={styles.photoBlock}>
                <Text style={styles.label}>Profile photo</Text>
                {profileImage ? (
                  <Image source={{ uri: profileImage }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.placeholder]} />
                )}
                <GlowButton label="Change" variant="outline" onPress={() => void pickImage("profile")} disabled={saving} />
              </View>
              <View style={styles.photoBlock}>
                <Text style={styles.label}>Cover / logo</Text>
                {coverImage ? (
                  <Image source={{ uri: coverImage }} style={styles.cover} />
                ) : (
                  <View style={[styles.cover, styles.placeholder]} />
                )}
                <GlowButton label="Change" variant="outline" onPress={() => void pickImage("cover")} disabled={saving} />
              </View>
            </View>

            <Text style={styles.sectionLabel}>Basic info</Text>
            <Text style={styles.label}>Display name</Text>
            <TextInput value={name} onChangeText={setName} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />
            <Text style={styles.label}>Portfolio headline</Text>
            <TextInput
              value={headline}
              onChangeText={setHeadline}
              style={styles.input}
              placeholder="e.g. Master barber · fades & beard work"
              placeholderTextColor="rgba(255,255,255,0.35)"
            />
            <Text style={styles.label}>Years of experience</Text>
            <TextInput
              value={yearsExperience}
              onChangeText={setYearsExperience}
              style={styles.input}
              keyboardType="number-pad"
              placeholder="e.g. 12"
              placeholderTextColor="rgba(255,255,255,0.35)"
            />
            <Text style={styles.label}>Bio</Text>
            <TextInput
              value={bio}
              onChangeText={setBio}
              style={[styles.input, styles.bio]}
              multiline
              placeholderTextColor="rgba(255,255,255,0.35)"
            />

            <Text style={styles.sectionLabel}>Shop & contact</Text>
            <Text style={styles.label}>Shop name</Text>
            <TextInput value={shopName} onChangeText={setShopName} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />
            <Text style={styles.label}>Phone</Text>
            <TextInput value={phone} onChangeText={setPhone} style={styles.input} keyboardType="phone-pad" placeholderTextColor="rgba(255,255,255,0.35)" />
            <Text style={styles.label}>Street address</Text>
            <TextInput value={address} onChangeText={setAddress} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />
            <View style={styles.row}>
              <View style={styles.half}>
                <Text style={styles.label}>City</Text>
                <TextInput value={city} onChangeText={setCity} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />
              </View>
              <View style={styles.half}>
                <Text style={styles.label}>State</Text>
                <TextInput value={state} onChangeText={setState} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />
              </View>
            </View>
            <Text style={styles.label}>Location label (shown on map/booking)</Text>
            <TextInput value={location} onChangeText={setLocation} style={styles.input} placeholderTextColor="rgba(255,255,255,0.35)" />
          </ProfileCard>
          <GlowButton label={saving ? "Saving…" : "Save profile"} onPress={onSave} disabled={saving} loading={saving} />
        </ScrollView>
      ) : null}
    </ProfileScreenLayout>
  );
}

export default function BarberEditScreen() {
  return (
    <StaffRosterGuard>
      <BarberEditInner />
    </StaffRosterGuard>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 32, gap: 12 },
  form: { gap: 8 },
  sectionLabel: { color: theme.colors.gold, fontSize: 14, fontWeight: "800", marginTop: 8 },
  label: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "600", marginTop: 4 },
  input: {
    color: theme.colors.text,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  bio: { minHeight: 90, textAlignVertical: "top" },
  photoRow: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  photoBlock: { flex: 1, minWidth: 140, gap: 8 },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: theme.colors.bg2 },
  cover: { width: "100%", height: 88, borderRadius: 10, backgroundColor: theme.colors.bg2 },
  placeholder: { borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  row: { flexDirection: "row", gap: 8 },
  half: { flex: 1 },
});
