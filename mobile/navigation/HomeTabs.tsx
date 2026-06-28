/**
 * HomeTabs — the post-auth Tab.Navigator for Build 23.
 *
 * Replaces the Build 22 `DashboardShell` placeholder with the real customer
 * surface. Critically, every tab is mounted through `<LazyScreen />`, which
 * means:
 *
 *   - A module-load throw inside any tab's transitive imports renders a
 *     "Feature unavailable" card on that tab only — the rest of the tab bar
 *     keeps working. This is the property the user demanded: one broken
 *     feature must never crash the entire app again.
 *
 *   - Each tab gets a `SafeAreaView` per LazyScreen, so notch / Dynamic
 *     Island / home indicator never clip content regardless of which
 *     screen the user is on.
 *
 *   - Loading states are visible (gold ActivityIndicator + label) — never
 *     blank — during the brief deferred-require window.
 *
 * Loaders are declared at module scope so React.useEffect's dependency
 * array sees the same function identity across re-renders. Inline
 * `() => require(...)` would re-run the effect every render.
 *
 * Tabs in this build:
 *
 *   1. Home    -> app/(tabs)/explore.tsx
 *   2. Book    -> screens/BookingScreen.js
 *   3. AURA    -> screens/AuraScreen.tsx
 *   4. Profile -> app/(tabs)/profile.tsx        (re-exports navigation/ProfileStack)
 *   5. Admin   -> navigation/AdminStack.tsx     (only when `isPlatformAdmin`)
 *
 * Services / Roster / Payment / Notifications are NOT tabs — they are
 * deeper destinations reachable from inside Book and Profile, and they
 * receive the same LazyScreen treatment when they are wired into stack
 * routes in subsequent builds. Keeping the visible tab count to five
 * preserves the Build 22 stable shell footprint and matches the design
 * the customer base is already used to.
 */

import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { createBottomTabNavigator, BottomTabBar } from "@react-navigation/bottom-tabs";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../services/authContext";
import { LazyScreen } from "../components/LazyScreen";
import IFCDCFooter from "../components/IFCDCFooter";
import { IFCDC_FOOTER_HEIGHT } from "../constants/profileLayout";
import { palette, shadow, tabBar, typography } from "../constants/theme";

const Tab = createBottomTabNavigator();

type Loader = () => unknown;

// Stable loader references — declared at module scope so LazyScreen's
// useEffect dependency array sees a constant function identity.
const HOME_LOADER: Loader = () => require("../app/(tabs)/explore");
const BOOK_LOADER: Loader = () => require("./BookStack");
const AURA_LOADER: Loader = () => require("../screens/AuraScreen");
const PROFILE_LOADER: Loader = () => require("../app/(tabs)/profile");
const ADMIN_LOADER: Loader = () => require("./AdminStack");

// Each tab is a thin wrapper component declared at module scope so React
// Navigation gets a stable component identity per tab. Defining these
// inside the parent render would cause a remount per parent render.
function HomeTabScreen() {
  return <LazyScreen feature="home" loader={HOME_LOADER} />;
}
function BookTabScreen() {
  return <LazyScreen feature="book" loader={BOOK_LOADER} />;
}
function AuraTabScreen() {
  return <LazyScreen feature="aura" loader={AURA_LOADER} />;
}
function ProfileTabScreen() {
  return <LazyScreen feature="profile" loader={PROFILE_LOADER} />;
}
function AdminTabScreen() {
  return <LazyScreen feature="admin" loader={ADMIN_LOADER} />;
}

function tabIcon(name: keyof typeof Ionicons.glyphMap) {
  return ({ focused }: { focused: boolean }) => (
    <View style={tabIconStyles.wrap}>
      {focused ? <View style={tabIconStyles.activePill} /> : null}
      <Ionicons
        name={name}
        size={focused ? tabBar.iconActiveSize : tabBar.iconInactiveSize}
        color={focused ? tabBar.activeTint : tabBar.inactiveTint}
      />
      {focused ? <View style={tabIconStyles.activeDot} /> : null}
    </View>
  );
}

function TabBarWithFooter(props: BottomTabBarProps) {
  return (
    <View style={tabBarShellStyles.wrap}>
      <View style={tabBarShellStyles.footerStrip}>
        <IFCDCFooter compact showPowered={false} />
      </View>
      <BottomTabBar {...props} />
    </View>
  );
}

function logTabFocus(name: string) {
  console.log(`[nav] tab: ${name}`);
}

export default function HomeTabs() {
  const insets = useSafeAreaInsets();
  const tabIconsHeight = 60;
  const tabBarHeight = tabIconsHeight + IFCDC_FOOTER_HEIGHT + Math.max(insets.bottom, 8);

  // useAuth is wrapped in try/catch so even a transient AuthProvider hiccup
  // (token refresh during a re-render, etc.) cannot crash the tab navigator.
  let isPlatformAdmin = false;
  let approvalPending = false;
  let approvalMessage = "";
  try {
    const auth = useAuth();
    isPlatformAdmin = Boolean(auth.isPlatformAdmin);
    approvalPending = Boolean(auth.approvalPending);
    approvalMessage = String(auth.user?.message || "Your account is pending Super Admin approval.");
  } catch (e) {
    console.warn("[nav] useAuth() failed inside HomeTabs (admin tab hidden):", String(e));
  }

  React.useEffect(() => {
    console.log("[nav] HomeTabs mounted", { isPlatformAdmin, platform: Platform.OS });
  }, [isPlatformAdmin]);

  return (
    <View style={{ flex: 1 }}>
      {approvalPending && !isPlatformAdmin ? (
        <View style={pendingBannerStyles.wrap}>
          <Text style={pendingBannerStyles.title}>Pending approval</Text>
          <Text style={pendingBannerStyles.body}>{approvalMessage}</Text>
        </View>
      ) : null}
      <Tab.Navigator
      tabBar={(props) => <TabBarWithFooter {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: tabBar.background,
          borderTopWidth: 1,
          borderTopColor: tabBar.borderTopColor,
          height: tabBarHeight,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: 8,
          ...shadow.deep,
        },
        tabBarActiveTintColor: tabBar.activeTint,
        tabBarInactiveTintColor: tabBar.inactiveTint,
        tabBarLabelStyle: {
          ...typography.micro,
          fontSize: tabBar.labelSize,
          textTransform: "none",
          letterSpacing: 0.35,
          marginTop: 2,
          marginBottom: 2,
        },
        tabBarItemStyle: { paddingTop: 4 },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeTabScreen}
        options={{ tabBarLabel: "Home", tabBarIcon: tabIcon("home") }}
        listeners={{ focus: () => logTabFocus("Home") }}
      />
      <Tab.Screen
        name="Book"
        component={BookTabScreen}
        options={{ tabBarLabel: "Book", tabBarIcon: tabIcon("calendar") }}
        listeners={{ focus: () => logTabFocus("Book") }}
      />
      <Tab.Screen
        name="AURA"
        component={AuraTabScreen}
        options={{ tabBarLabel: "AURA", tabBarIcon: tabIcon("sparkles") }}
        listeners={{ focus: () => logTabFocus("AURA") }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileTabScreen}
        options={{ tabBarLabel: "Profile", tabBarIcon: tabIcon("person") }}
        listeners={{ focus: () => logTabFocus("Profile") }}
      />
      {isPlatformAdmin ? (
        <Tab.Screen
          name="Admin"
          component={AdminTabScreen}
          options={{ tabBarLabel: "Admin", tabBarIcon: tabIcon("shield-checkmark") }}
          listeners={{ focus: () => logTabFocus("Admin") }}
        />
      ) : null}
    </Tab.Navigator>
    </View>
  );
}

const pendingBannerStyles = StyleSheet.create({
  wrap: {
    backgroundColor: "rgba(245,200,66,0.15)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(245,200,66,0.35)",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { color: palette.gold, fontWeight: "800", fontSize: 13 },
  body: { color: palette.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },
});

const tabBarShellStyles = StyleSheet.create({
  wrap: {
    backgroundColor: tabBar.background,
    borderTopWidth: 1,
    borderTopColor: tabBar.borderTopColor,
    ...shadow.deep,
  },
  footerStrip: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(212,175,55,0.12)",
  },
});

const tabIconStyles = StyleSheet.create({
  wrap: { width: 48, height: 34, alignItems: "center", justifyContent: "center" },
  activePill: {
    position: "absolute",
    top: 1,
    width: tabBar.pillWidth,
    height: tabBar.pillHeight,
    borderRadius: tabBar.pillRadius,
    backgroundColor: tabBar.pillBackground,
    borderWidth: 1,
    borderColor: tabBar.pillBorder,
    ...tabBar.pillGlow,
  },
  activeDot: {
    position: "absolute",
    bottom: -2,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: palette.gold,
    ...shadow.glowGold,
  },
});
