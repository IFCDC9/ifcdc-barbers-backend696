/**
 * AppRoot.tsx — Build 23 production-shell reintegration on top of the
 * Build 22 stable boot. This module is lazy-`require()`-d from App.tsx,
 * so any module-load throw here is caught and surfaced as "System Recovery
 * Mode" instead of a silent black screen.
 *
 * Boot phases (visible in the JS console):
 *   ROOT START    (App.tsx renders placeholder)        — Build 21 baseline
 *   STORAGE READY (AsyncStorage probe completed)       — phase 1
 *   AUTH READY    (SecureStore probe completed)        — phase 2
 *   API READY     (BACKEND_URL validated)              — phase 3
 *   NAV READY     (NavigationContainer onReady fired)  — after gate
 *   HOME READY    (HomeTabs / Login mounted)           — final
 *
 * Build 23 promotes the post-auth route from a static `DashboardShell`
 * to `<HomeTabs />`, the real customer surface (Home, Book, AURA, Profile,
 * conditional Admin). Each tab is mounted through `<LazyScreen />`, which
 * isolates module-load and render-time failures to a single feature card
 * so the overall app stays alive when one feature throws.
 *
 * Architectural rules preserved from Build 22 (do NOT regress):
 *   - Single NavigationContainer (here, in AuthGate). Nested navigators
 *     inside tabs (AdminStack, ProfileStack) are plain Stack.Navigators,
 *     never their own NavigationContainer.
 *   - No expo-router imports anywhere in the entry chain.
 *   - AuthGate sequence (storage → auth → api → ready) is unchanged.
 *   - AuthProvider, SafeAreaProvider, i18n initialisation untouched.
 *   - Each provider keeps its ProviderBoundary; HomeTabs gets one too.
 *
 * Deliberately deferred to later builds:
 *   - Stack routes for BookingDetail, Reschedule, Cancel, EditProfile, etc.
 *     (each will be added through LazyScreen the same way the tabs are)
 *   - expo-notifications service + push-token registration
 *   - Heavy animations / video backgrounds / realtime sockets
 */

import React from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer, CommonActions } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { addNotificationListeners } from "./services/notificationService";

// i18next must be imported before any screen using `useTranslation()`. The
// `./i18n` module's bottom calls `initSync()`, so this triggers the
// synchronous default-English init at import time.
import i18n, { currentLanguage } from "./i18n";
import { softLayoutDirection } from "./i18n/rtlLayout";

import { AuthProvider, useAuth } from "./services/authContext";
import { BACKEND_URL } from "./constants/config";

import LoginScreen from "./screens/LoginScreen";
import RegisterScreen from "./screens/RegisterScreen";
import PasswordResetScreen from "./screens/PasswordResetScreen";
import HomeTabs from "./navigation/HomeTabs";

console.log("[startup] AppRoot module loaded");

const Stack = createStackNavigator();

// ─────────────────────────────────────────────────────────────────────────────
// ProviderBoundary — fail-safe wrapper for each major provider. If anything
// inside throws during render, we render a labelled "System Recovery Mode"
// surface instead of letting the error bubble to a blank screen.
// ─────────────────────────────────────────────────────────────────────────────

class ProviderBoundary extends React.Component<
  { name: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[startup] ProviderBoundary[${this.props.name}] caught:`,
      error?.message,
      info?.componentStack,
    );
  }

  render() {
    const err = this.state.error;
    if (!err) return this.props.children;
    return (
      <View style={recoveryStyles.root}>
        <ScrollView contentContainerStyle={recoveryStyles.scroll}>
          <Text style={recoveryStyles.title}>System Recovery Mode</Text>
          <Text style={recoveryStyles.subtitle}>BUILD 24</Text>
          <View style={recoveryStyles.divider} />
          <Text style={recoveryStyles.label}>Failed provider</Text>
          <Text style={recoveryStyles.body} selectable>
            {this.props.name}
          </Text>
          <Text style={recoveryStyles.label}>Error</Text>
          <Text style={recoveryStyles.body} selectable>
            {err?.message || String(err)}
          </Text>
          {err?.stack ? (
            <>
              <Text style={recoveryStyles.label}>Stack</Text>
              <Text style={recoveryStyles.body} selectable>
                {err.stack}
              </Text>
            </>
          ) : null}
        </ScrollView>
      </View>
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BootProgress — visible feedback during the AuthGate phases.
// ─────────────────────────────────────────────────────────────────────────────

function BootProgress({ phase }: { phase: string }) {
  return (
    <View style={progressStyles.root}>
      <Text style={progressStyles.title}>IFCDC Barbers</Text>
      <View style={{ height: 16 }} />
      <ActivityIndicator color="#F5C842" />
      <View style={{ height: 12 }} />
      <Text style={progressStyles.subtitle}>Initializing… {phase}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthGate — sequential boot phases. Mounts the navigator only once storage,
// auth, and API config have each been probed. Critically, we do NOT block on
// `useAuth().loading` here (which performs the /auth/me network call that
// can hang up to 15s). The navigator renders as soon as the local probes
// complete; AuthProvider continues its background refresh and the navigator
// reactively switches token-aware routes when it finishes.
// ─────────────────────────────────────────────────────────────────────────────

type GatePhase = "storage" | "auth" | "api" | "ready";

const navigationRef = React.createRef<any>();

function openBookingReview(bookingId: string) {
  const id = String(bookingId || "").trim();
  if (!id || !navigationRef.current) return;
  try {
    navigationRef.current.dispatch(
      CommonActions.navigate({
        name: "Main",
        params: {
          screen: "Profile",
          params: {
            screen: "BookingReview",
            params: { bookingId: id },
          },
        },
      }),
    );
  } catch (e) {
    console.warn("[deep-link] openBookingReview failed:", String(e));
  }
}

function parseReviewDeepLink(url: string | null | undefined): string | null {
  const raw = String(url || "").trim();
  if (!raw) return null;
  // ifcdc-barbers://review/{bookingId}
  // https://ifcdcbarbersapp.com/profile/bookings/{id}/review
  const appMatch = raw.match(/(?:ifcdc-barbers:\/\/review\/|\/profile\/bookings\/)([^/?#]+)/i);
  if (appMatch?.[1]) return decodeURIComponent(appMatch[1]);
  return null;
}

function AuthGate() {
  const { token } = useAuth();
  const [phase, setPhase] = React.useState<GatePhase>("storage");

  React.useEffect(() => {
    if (!token) return;
    const unsub = addNotificationListeners({
      onResponse: (response) => {
        const data = (response?.notification?.request?.content?.data || {}) as Record<string, unknown>;
        const type = String(data.type || "");
        const bookingId = String(data.bookingId || "");
        if (type === "leave_review" && bookingId) {
          openBookingReview(bookingId);
          return;
        }
        const fromUrl = parseReviewDeepLink(String(data.url || data.webUrl || ""));
        if (fromUrl) openBookingReview(fromUrl);
      },
    });
    const linkingSub = Linking.addEventListener("url", ({ url }) => {
      const id = parseReviewDeepLink(url);
      if (id) openBookingReview(id);
    });
    void Linking.getInitialURL().then((url) => {
      const id = parseReviewDeepLink(url);
      if (id) openBookingReview(id);
    });
    return () => {
      unsub();
      linkingSub.remove();
    };
  }, [token]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await AsyncStorage.getItem("@ifcdc/lang");
      } catch (e) {
        console.warn("[startup] AsyncStorage probe failed (ignored):", String(e));
      }
      if (cancelled) return;
      console.log("[startup] STORAGE READY");
      setPhase("auth");

      try {
        await SecureStore.getItemAsync("ifcdc_auth_token");
      } catch (e) {
        console.warn("[startup] SecureStore probe failed (ignored):", String(e));
      }
      if (cancelled) return;
      console.log("[startup] AUTH READY");
      setPhase("api");

      try {
        if (!BACKEND_URL || !/^https?:\/\//.test(BACKEND_URL)) {
          console.warn("[startup] API config invalid (continuing anyway):", BACKEND_URL);
        } else {
          console.log("[startup] API READY", { backend: BACKEND_URL });
        }
      } catch (e) {
        console.warn("[startup] API config probe threw (ignored):", String(e));
      }
      if (cancelled) return;
      setPhase("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase !== "ready") {
    return <BootProgress phase={phase.toUpperCase()} />;
  }

  return (
    <ProviderBoundary name="NavigationContainer">
      <NavigationContainer
        ref={navigationRef}
        linking={{
          prefixes: ["ifcdc-barbers://", "https://ifcdcbarbersapp.com", "https://www.ifcdcbarbersapp.com"],
          config: {
            screens: {
              Main: {
                screens: {
                  Profile: {
                    screens: {
                      BookingReview: "review/:bookingId",
                      BookingDetail: "booking/:bookingId",
                    },
                  },
                },
              },
              Login: "login",
            },
          },
        }}
        onReady={() => console.log("[startup] NAV READY", { hasToken: Boolean(token) })}
      >
        <Stack.Navigator
          key={token ? "app" : "auth"}
          screenOptions={{ headerShown: false }}
          initialRouteName={token ? "Main" : "Login"}
        >
          {token ? (
            <Stack.Screen name="Main" component={MainShell} />
          ) : (
            <>
              <Stack.Screen name="Login" component={LoginScreen} />
              <Stack.Screen name="Register" component={RegisterScreen} />
              <Stack.Screen name="PasswordReset" component={PasswordResetScreen} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </ProviderBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MainShell — the post-auth tabbed surface. Wrapped in a ProviderBoundary so
// a render failure inside the tab navigator (e.g. icon library, useAuth blip)
// renders System Recovery Mode instead of black-screening the navigator. The
// boundary owns logging the [startup] HOME READY signal once the tab navigator
// has rendered for the first time.
// ─────────────────────────────────────────────────────────────────────────────

function MainShell() {
  React.useEffect(() => {
    console.log("[startup] HOME READY");
  }, []);
  return (
    <ProviderBoundary name="HomeTabs">
      <HomeTabs />
    </ProviderBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AppRoot — the heavy provider tree, lazily required from App.tsx.
// ─────────────────────────────────────────────────────────────────────────────

function SoftRtlShell({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = React.useState(() => currentLanguage());

  React.useEffect(() => {
    const onChanged = () => setLang(currentLanguage());
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, []);

  return (
    <View style={{ flex: 1, direction: softLayoutDirection(lang) }}>
      {children}
    </View>
  );
}

export default function AppRoot() {
  console.log("[startup] AppRoot render");

  React.useEffect(() => {
    void import("./i18n")
      .then((m) => m.bootstrapI18n())
      .then((bootLang) => console.log("[startup] i18n bootstrapped:", bootLang))
      .catch((e) => console.warn("[startup] i18n bootstrap failed:", e?.message || e));
  }, []);

  return (
    <ProviderBoundary name="SafeAreaProvider">
      <SafeAreaProvider>
        <SoftRtlShell>
          <ProviderBoundary name="AuthProvider">
            <AuthProvider>
              <AuthGate />
            </AuthProvider>
          </ProviderBoundary>
        </SoftRtlShell>
      </SafeAreaProvider>
    </ProviderBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const progressStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0b0b0b",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "#F5C842",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 1.0,
  },
  subtitle: {
    color: "#bdbdbd",
    fontSize: 12,
    letterSpacing: 1.2,
    fontWeight: "600",
  },
});

const recoveryStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0b0b" },
  scroll: { padding: 24, paddingTop: 72 },
  title: {
    color: "#F5C842",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 1.0,
    textAlign: "center",
    marginBottom: 4,
  },
  subtitle: {
    color: "#bdbdbd",
    fontSize: 12,
    letterSpacing: 1.2,
    fontWeight: "600",
    textAlign: "center",
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(245,200,66,0.45)",
    marginVertical: 18,
    width: 120,
    alignSelf: "center",
  },
  label: {
    color: "#F5C842",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    marginTop: 14,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  body: { color: "#fff", fontSize: 13, lineHeight: 19 },
});
