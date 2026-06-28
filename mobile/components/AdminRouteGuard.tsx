import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useAuth } from "../services/authContext";
import { theme } from "../constants/theme";

type Props = {
  children: React.ReactNode;
};

/** Blocks staff dashboard for customers; allows super_admin, admin, shop_owner. */
export default function AdminRouteGuard({ children }: Props) {
  const { hasStaffDashboard, loading } = useAuth();
  const navigation = useNavigation();

  React.useEffect(() => {
    if (!loading && !hasStaffDashboard) {
      const parent = navigation.getParent();
      if (parent && "navigate" in parent) {
        (parent as { navigate: (name: string) => void }).navigate("Home");
      }
    }
  }, [hasStaffDashboard, loading, navigation]);

  if (loading) return <View style={styles.blocked} />;

  if (!hasStaffDashboard) {
    return (
      <View style={styles.blocked}>
        <Text style={styles.denied}>Access denied</Text>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  blocked: {
    flex: 1,
    backgroundColor: theme.colors.bg0,
    alignItems: "center",
    justifyContent: "center",
  },
  denied: { color: theme.colors.textMuted, fontSize: 15 },
});
