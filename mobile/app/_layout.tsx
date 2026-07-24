import React from "react";
import { StyleSheet, View } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import ExploreScreen from "./(tabs)/explore";
import ProfileScreen from "./(tabs)/profile";
import BookingScreen from "../screens/BookingScreen";
import AppointmentsScreen from "../screens/AppointmentsScreen";
import AuraScreen from "../screens/AuraScreen";
import AdminStack from "../navigation/AdminStack";
import Colors from "../constants/Colors";
import ThemedView from "../components/ThemedView";
import { palette } from "../constants/theme";
import { useAuth } from "../services/authContext";
import { enterAdminLanguageMode, exitAdminLanguageMode } from "../i18n";

const Tab = createBottomTabNavigator();

const ACTIVE = palette.gold;
const INACTIVE = palette.textDim;

function logTab(name: string) {
  console.log(`[nav] tab: ${name}`);
}

/**
 * Renders the focused tab icon inside a soft circular gold glow halo.
 * Inactive tabs render the bare icon for cleaner negative space.
 */
function TabIcon({
  name,
  focused,
}: {
  name: keyof typeof Ionicons.glyphMap;
  focused: boolean;
}) {
  return (
    <View style={tabIconStyles.wrap}>
      {focused ? <View style={tabIconStyles.activeBg} /> : null}
      <Ionicons name={name} size={focused ? 22 : 21} color={focused ? ACTIVE : INACTIVE} />
      {focused ? <View style={tabIconStyles.activeDot} /> : null}
    </View>
  );
}

const tabIconStyles = StyleSheet.create({
  wrap: {
    width: 44,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  activeBg: {
    position: "absolute",
    top: 2,
    width: 38,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(245,200,66,0.10)",
    borderWidth: 1,
    borderColor: "rgba(245,200,66,0.32)",
  },
  activeDot: {
    position: "absolute",
    bottom: -3,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: ACTIVE,
    shadowColor: ACTIVE,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.85,
    shadowRadius: 4,
    elevation: 4,
  },
});

const Tabs = () => {
  const { isPlatformAdmin } = useAuth();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const tabBarHeight = 60 + Math.max(insets.bottom, 8);

  return (
    <ThemedView style={{ flex: 1, backgroundColor: Colors.background }}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: "rgba(8,8,8,0.96)",
            borderTopWidth: 1,
            borderTopColor: "rgba(245,200,66,0.18)",
            height: tabBarHeight,
            paddingBottom: Math.max(insets.bottom, 8),
            paddingTop: 8,
            elevation: 18,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: -8 },
            shadowOpacity: 0.4,
            shadowRadius: 16,
          },
          tabBarActiveTintColor: ACTIVE,
          tabBarInactiveTintColor: INACTIVE,
          tabBarLabelStyle: {
            fontSize: 10.5,
            fontWeight: "700",
            letterSpacing: 0.3,
            marginTop: 2,
            marginBottom: 2,
          },
          tabBarItemStyle: { paddingTop: 4 },
        }}
      >
        <Tab.Screen
          name="Home"
          component={ExploreScreen}
          options={{
            tabBarLabel: t("tabs.home"),
            tabBarIcon: ({ focused }) => (
              <TabIcon name={focused ? "home" : "home-outline"} focused={focused} />
            ),
          }}
          listeners={{ focus: () => logTab("Home") }}
        />
        <Tab.Screen
          name="Book"
          component={BookingScreen}
          options={{
            tabBarLabel: t("tabs.book"),
            tabBarIcon: ({ focused }) => (
              <TabIcon name={focused ? "calendar" : "calendar-outline"} focused={focused} />
            ),
          }}
          listeners={{ focus: () => logTab("Book") }}
        />
        <Tab.Screen
          name="Appointments"
          component={AppointmentsScreen}
          options={{
            tabBarLabel: t("tabs.appointments"),
            tabBarIcon: ({ focused }) => (
              <TabIcon name={focused ? "list" : "list-outline"} focused={focused} />
            ),
          }}
          listeners={{ focus: () => logTab("Appointments") }}
        />
        <Tab.Screen
          name="AURA"
          component={AuraScreen}
          options={{
            tabBarLabel: t("tabs.aura"),
            tabBarIcon: ({ focused }) => (
              <TabIcon
                name={focused ? "sparkles" : "sparkles-outline"}
                focused={focused}
              />
            ),
          }}
          listeners={{ focus: () => logTab("AURA") }}
        />
        <Tab.Screen
          name="Profile"
          component={ProfileScreen}
          options={{
            tabBarLabel: t("tabs.profile"),
            tabBarIcon: ({ focused }) => (
              <TabIcon name={focused ? "person" : "person-outline"} focused={focused} />
            ),
          }}
          listeners={{ focus: () => logTab("Profile") }}
        />
        {isPlatformAdmin ? (
          <Tab.Screen
            name="Admin"
            component={AdminStack}
            options={{
              tabBarLabel: "Admin",
              tabBarIcon: ({ focused }) => (
                <TabIcon
                  name={focused ? "shield-checkmark" : "shield-checkmark-outline"}
                  focused={focused}
                />
              ),
            }}
            listeners={{
              focus: () => {
                logTab("Admin");
                void enterAdminLanguageMode();
              },
              blur: () => {
                void exitAdminLanguageMode();
              },
            }}
          />
        ) : null}
      </Tab.Navigator>
    </ThemedView>
  );
};

export default Tabs;
