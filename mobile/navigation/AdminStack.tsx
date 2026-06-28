import React from "react";
import { createStackNavigator } from "@react-navigation/stack";
import AdminRouteGuard from "../components/AdminRouteGuard";
import AdminHomeScreen from "../screens/admin/AdminHomeScreen";
import AdminBookingsScreen from "../screens/admin/AdminBookingsScreen";
import AdminBookingDetailScreen from "../screens/admin/AdminBookingDetailScreen";
import BookingDetailScreen from "../screens/profile/BookingDetailScreen";
import CancelBookingScreen from "../screens/profile/CancelBookingScreen";
import RescheduleBookingScreen from "../screens/profile/RescheduleBookingScreen";
import AdminBarbersScreen from "../screens/admin/AdminBarbersScreen";
import AdminGlobalBarbersScreen from "../screens/admin/AdminGlobalBarbersScreen";
import AdminShopScreen from "../screens/admin/AdminShopScreen";
import AdminShopDetailScreen from "../screens/admin/AdminShopDetailScreen";
import AdminPayoutScreen from "../screens/admin/AdminPayoutScreen";
import PlatformFeeDetailScreen from "../screens/admin/payout/PlatformFeeDetailScreen";
import TotalCollectedDetailScreen from "../screens/admin/payout/TotalCollectedDetailScreen";
import OutstandingBalanceDetailScreen from "../screens/admin/payout/OutstandingBalanceDetailScreen";
import PendingInPersonDetailScreen from "../screens/admin/payout/PendingInPersonDetailScreen";
import PayoutBookingSummaryScreen from "../screens/admin/payout/PayoutBookingSummaryScreen";
import AdminAnalyticsScreen from "../screens/admin/AdminAnalyticsScreen";
import AdminNotificationsScreen from "../screens/admin/AdminNotificationsScreen";
import PlatformNotificationsScreen from "../screens/admin/PlatformNotificationsScreen";
import MobileNotificationSettingsScreen from "../screens/admin/MobileNotificationSettingsScreen";
import AdminScheduleScreen from "../screens/admin/AdminScheduleScreen";
import AdminUsersScreen from "../screens/admin/AdminUsersScreen";
import ViewAllUsersScreen from "../screens/admin/ViewAllUsersScreen";
import UserDetailScreen from "../screens/admin/UserDetailScreen";
import EditUserScreen from "../screens/admin/EditUserScreen";
import ManageRolesScreen from "../screens/admin/ManageRolesScreen";
import InviteUserScreen from "../screens/admin/InviteUserScreen";
import AdminAccessAuditScreen from "../screens/admin/AdminAccessAuditScreen";
import ResetUserPasswordScreen from "../screens/admin/ResetUserPasswordScreen";
import SuperAdminRouteGuard from "../components/SuperAdminRouteGuard";
import EditBarberScheduleScreen from "../screens/schedule/EditBarberScheduleScreen";
import ScheduleRouteGuard from "../components/ScheduleRouteGuard";
import BarberDetailScreen from "../screens/barber/BarberDetailScreen";
import BarberEditScreen from "../screens/barber/BarberEditScreen";
import BarberGalleryScreen from "../screens/barber/BarberGalleryScreen";
import BarberServicesScreen from "../screens/barber/BarberServicesScreen";
import EditServiceScreen from "../screens/barber/EditServiceScreen";
import ShopDetailScreen from "../screens/shop/ShopDetailScreen";
import ShopEditScreen from "../screens/shop/ShopEditScreen";
import AdminContentModerationScreen from "../screens/admin/AdminContentModerationScreen";
import { PAYMENT_STACK_SCREENS } from "./paymentScreens";
import type { PaymentStackParamList } from "./paymentStackTypes";

export type AdminStackParamList = {
  AdminHome: undefined;
  AdminBookings: { barberId?: string; barberName?: string } | undefined;
  AdminBookingDetail: { bookingId: string };
  BookingDetail: { bookingId: string };
  CancelBooking: { bookingId: string };
  RescheduleBooking: { bookingId: string };
  AdminBarbers: undefined;
  AdminGlobalBarbers: undefined;
  AdminShop: undefined;
  AdminShopDetail: { shopId: string; shopName: string };
  AdminPayout: undefined;
  PlatformFeeDetail: undefined;
  TotalCollectedDetail: undefined;
  OutstandingBalanceDetail: undefined;
  PendingInPersonDetail: undefined;
  PayoutBookingSummary: undefined;
  AdminAnalytics: undefined;
  AdminNotifications: undefined;
  PlatformNotifications: undefined;
  MobileNotificationSettings: undefined;
  AdminSchedule: undefined;
  AdminUsers: undefined;
  ViewAllUsers: undefined;
  UserDetail: { userId: string };
  EditUser: { userId: string };
  ManageRolesScreen: undefined;
  InviteUserScreen: undefined;
  AdminAccessAuditScreen: { initialSearch?: string } | undefined;
  ResetUserPasswordScreen: { userId?: string } | undefined;
  EditBarberSchedule: { barberId: string; barberName: string };
  BarberDetail: { barberId: string; barberName: string };
  BarberEdit: { barberId: string; barberName: string };
  BarberGallery: { barberId: string; barberName: string };
  BarberServices: { barberId: string; barberName: string };
  EditService: { barberId: string; barberName: string; serviceId?: string };
  ShopDetail: { businessId: string; shopName: string; isPlaceholder?: boolean };
  ShopEdit: { businessId: string; shopName: string; isPlaceholder?: boolean };
  AdminContentModeration: undefined;
} & PaymentStackParamList;

const Stack = createStackNavigator<AdminStackParamList>();

function AdminStackInner() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="AdminHome" component={AdminHomeScreen} />
      <Stack.Screen name="AdminBookings" component={AdminBookingsScreen} />
      <Stack.Screen name="AdminBookingDetail" component={AdminBookingDetailScreen} />
      <Stack.Screen name="BookingDetail" component={BookingDetailScreen} />
      <Stack.Screen name="CancelBooking" component={CancelBookingScreen} />
      <Stack.Screen name="RescheduleBooking" component={RescheduleBookingScreen} />
      <Stack.Screen name="AdminBarbers" component={AdminBarbersScreen} />
      <Stack.Screen name="AdminGlobalBarbers" component={AdminGlobalBarbersScreen} />
      <Stack.Screen name="AdminContentModeration" component={AdminContentModerationScreen} />
      <Stack.Screen name="AdminShop" component={AdminShopScreen} />
      <Stack.Screen name="AdminShopDetail" component={AdminShopDetailScreen} />
      <Stack.Screen name="AdminPayout" component={AdminPayoutScreen} />
      <Stack.Screen name="PlatformFeeDetail" component={PlatformFeeDetailScreen} />
      <Stack.Screen name="TotalCollectedDetail" component={TotalCollectedDetailScreen} />
      <Stack.Screen name="OutstandingBalanceDetail" component={OutstandingBalanceDetailScreen} />
      <Stack.Screen name="PendingInPersonDetail" component={PendingInPersonDetailScreen} />
      <Stack.Screen name="PayoutBookingSummary" component={PayoutBookingSummaryScreen} />
      <Stack.Screen name="AdminAnalytics" component={AdminAnalyticsScreen} />
      <Stack.Screen name="AdminNotifications" component={AdminNotificationsScreen} />
      <Stack.Screen name="PlatformNotifications" component={PlatformNotificationsScreen} />
      <Stack.Screen name="MobileNotificationSettings" component={MobileNotificationSettingsScreen} />
      <Stack.Screen name="AdminSchedule" component={AdminScheduleScreen} />
      <Stack.Screen name="AdminUsers">
        {() => (
          <SuperAdminRouteGuard>
            <AdminUsersScreen />
          </SuperAdminRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="ViewAllUsers" component={ViewAllUsersScreen} />
      <Stack.Screen name="UserDetail" component={UserDetailScreen} />
      <Stack.Screen name="EditUser" component={EditUserScreen} />
      <Stack.Screen name="ManageRolesScreen">
        {() => (
          <SuperAdminRouteGuard>
            <ManageRolesScreen />
          </SuperAdminRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="InviteUserScreen">
        {() => (
          <SuperAdminRouteGuard>
            <InviteUserScreen />
          </SuperAdminRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="AdminAccessAuditScreen">
        {() => (
          <SuperAdminRouteGuard>
            <AdminAccessAuditScreen />
          </SuperAdminRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="ResetUserPasswordScreen">
        {() => (
          <SuperAdminRouteGuard>
            <ResetUserPasswordScreen />
          </SuperAdminRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="EditBarberSchedule">
        {() => (
          <ScheduleRouteGuard>
            <EditBarberScheduleScreen />
          </ScheduleRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="BarberDetail" component={BarberDetailScreen} />
      <Stack.Screen name="BarberEdit" component={BarberEditScreen} />
      <Stack.Screen name="BarberGallery" component={BarberGalleryScreen} />
      <Stack.Screen name="BarberServices" component={BarberServicesScreen} />
      <Stack.Screen name="EditService" component={EditServiceScreen} />
      <Stack.Screen name="ShopDetail" component={ShopDetailScreen} />
      <Stack.Screen name="ShopEdit" component={ShopEditScreen} />
      {PAYMENT_STACK_SCREENS.map(({ name, component }) => (
        <Stack.Screen key={`payment-${name}`} name={name} component={component} />
      ))}
    </Stack.Navigator>
  );
}

/** Admin tab root — only mounted when isPlatformAdmin; guarded on render. */
export default function AdminStack() {
  return (
    <AdminRouteGuard>
      <AdminStackInner />
    </AdminRouteGuard>
  );
}
