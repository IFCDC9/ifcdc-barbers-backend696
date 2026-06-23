import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import ProfileCard from "../../components/ProfileCard";
import { useAuth } from "../../services/authContext";
import { canAccessUserManagement } from "../../utils/userManagementAccess";
import { palette, typography } from "../../constants/theme";

export type AdminMenuItem = {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  route: string;
};

export const ADMIN_MENU: AdminMenuItem[] = [
  {
    key: "bookings",
    title: "Bookings management",
    subtitle: "View and manage platform bookings",
    icon: "📋",
    route: "AdminBookings",
  },
  {
    key: "services",
    title: "Service menu",
    subtitle: "Prices, photos, and availability",
    icon: "💈",
    route: "AdminBarbers",
  },
  {
    key: "barbers",
    title: "Barber management",
    subtitle: "Global platform barbers with filters",
    icon: "✂️",
    route: "AdminGlobalBarbers",
  },
  {
    key: "shop",
    title: "Shop management",
    subtitle: "Platform businesses and shop settings",
    icon: "🏪",
    route: "AdminShop",
  },
  {
    key: "payout",
    title: "Payout overview",
    subtitle: "Fees, balances, and collections",
    icon: "💰",
    route: "AdminPayout",
  },
  {
    key: "analytics",
    title: "Platform analytics",
    subtitle: "Revenue and booking metrics",
    icon: "📊",
    route: "AdminAnalytics",
  },
  {
    key: "notifications",
    title: "Notification controls",
    subtitle: "Push alerts and messaging",
    icon: "🔔",
    route: "AdminNotifications",
  },
  {
    key: "schedule",
    title: "Schedule controls",
    subtitle: "Availability and blocked dates",
    icon: "📅",
    route: "AdminSchedule",
  },
  {
    key: "users",
    title: "User management",
    subtitle: "Accounts and platform users",
    icon: "👥",
    route: "AdminUsers",
  },
];

type Nav = { navigate: (name: string) => void };

export function AdminMenuList({ navigation }: { navigation: Nav }) {
  const { user, token } = useAuth();
  const items = ADMIN_MENU.filter(
    (item) => item.key !== "users" || canAccessUserManagement(user, token),
  );

  return (
    <View style={styles.list}>
      {items.map((item) => (
        <Pressable key={item.key} onPress={() => navigation.navigate(item.route)} style={({ pressed }) => pressed && styles.pressed}>
          <ProfileCard style={styles.row}>
            <View style={styles.rowInner}>
              <Text style={styles.icon}>{item.icon}</Text>
              <View style={styles.copy}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.subtitle}>{item.subtitle}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </ProfileCard>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  pressed: { opacity: 0.85 },
  row: { paddingVertical: 4 },
  rowInner: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { fontSize: 22, width: 32, textAlign: "center" },
  copy: { flex: 1, gap: 2 },
  title: { ...typography.heading, fontSize: 16 },
  subtitle: { ...typography.caption, lineHeight: 18 },
  chevron: { color: palette.gold, fontSize: 22, fontWeight: "300" },
});
