import React from "react";
import { Platform, StyleProp, View, ViewStyle } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";

type Props = {
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function AppleSignInButton({ onPress, disabled, style }: Props) {
  if (Platform.OS !== "ios") return null;

  return (
    <View style={[{ width: "100%" }, disabled ? { opacity: 0.55 } : null]} pointerEvents={disabled ? "none" : "auto"}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={12}
        style={[{ width: "100%", height: 48 }, style]}
        onPress={onPress}
      />
    </View>
  );
}

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export type AppleCredential = {
  identityToken: string;
  email?: string | null;
  fullName?: string | null;
};

export async function requestAppleCredential(): Promise<AppleCredential> {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  const identityToken = credential.identityToken?.trim();
  if (!identityToken) {
    throw new Error("apple_identity_token_missing");
  }

  const given = credential.fullName?.givenName?.trim() || "";
  const family = credential.fullName?.familyName?.trim() || "";
  const fullName = [given, family].filter(Boolean).join(" ").trim() || null;

  return {
    identityToken,
    email: credential.email?.trim() || null,
    fullName,
  };
}
