import * as SecureStore from "expo-secure-store";

const KEY = "ifcdc_auth_token";

type TokenListener = (token: string | null) => void;
const tokenListeners = new Set<TokenListener>();

export function subscribeAuthToken(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

function notifyTokenListeners(token: string | null) {
  for (const listener of tokenListeners) {
    try {
      listener(token);
    } catch {
      /* ignore */
    }
  }
}

export async function setAuthToken(token: string | null): Promise<void> {
  if (!token) {
    await SecureStore.deleteItemAsync(KEY);
    notifyTokenListeners(null);
    return;
  }
  const normalized = String(token).trim().replace(/^Bearer\s+/i, "");
  await SecureStore.setItemAsync(KEY, normalized);
  notifyTokenListeners(normalized);
}

export async function getAuthToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(KEY);
  const trimmed = String(token || "").trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed.slice(7).trim();
  return trimmed;
}

