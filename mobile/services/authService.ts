import * as SecureStore from "expo-secure-store";

const KEY = "ifcdc_auth_token";

export async function setAuthToken(token: string | null): Promise<void> {
  if (!token) {
    await SecureStore.deleteItemAsync(KEY);
    return;
  }
  await SecureStore.setItemAsync(KEY, token);
}

export async function getAuthToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(KEY);
  const trimmed = String(token || "").trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed.slice(7).trim();
  return trimmed;
}

