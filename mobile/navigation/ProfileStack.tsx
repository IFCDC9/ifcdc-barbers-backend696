import React from "react";
import { createStackNavigator } from "@react-navigation/stack";
import ProfileHomeScreen from "../screens/profile/ProfileHomeScreen";
import EditProfileScreen from "../screens/profile/EditProfileScreen";
import BookingHistoryScreen from "../screens/profile/BookingHistoryScreen";
import BookingDetailScreen from "../screens/profile/BookingDetailScreen";
import CancelBookingScreen from "../screens/profile/CancelBookingScreen";
import RescheduleBookingScreen from "../screens/profile/RescheduleBookingScreen";
import NotificationsScreen from "../screens/profile/NotificationsScreen";
import LanguageSettingsScreen from "../screens/profile/LanguageSettingsScreen";
import DeleteAccountScreen from "../screens/profile/DeleteAccountScreen";
import TermsPrivacyScreen from "../screens/profile/TermsPrivacyScreen";
import LegalPoliciesIndexScreen from "../screens/legal/LegalPoliciesIndexScreen";
import PrivacyPolicyScreen from "../screens/legal/PrivacyPolicyScreen";
import TermsConditionsScreen from "../screens/legal/TermsConditionsScreen";
import CancellationPolicyScreen from "../screens/legal/CancellationPolicyScreen";
import PlatformFeeDisclosureScreen from "../screens/legal/PlatformFeeDisclosureScreen";
import AuraDisclosureScreen from "../screens/legal/AuraDisclosureScreen";
import BarberTermsScreen from "../screens/legal/BarberTermsScreen";
import NotificationConsentScreen from "../screens/legal/NotificationConsentScreen";
import SecurityNoticeScreen from "../screens/legal/SecurityNoticeScreen";
import ScheduleControlsScreen from "../screens/schedule/ScheduleControlsScreen";
import EditBarberScheduleScreen from "../screens/schedule/EditBarberScheduleScreen";
import ScheduleRouteGuard from "../components/ScheduleRouteGuard";
import BarberRosterScreen from "../screens/barber/BarberRosterScreen";
import BarberDetailScreen from "../screens/barber/BarberDetailScreen";
import BarberEditScreen from "../screens/barber/BarberEditScreen";
import BarberServicesScreen from "../screens/barber/BarberServicesScreen";
import EditServiceScreen from "../screens/barber/EditServiceScreen";
import ShopRosterScreen from "../screens/shop/ShopRosterScreen";
import ShopDetailScreen from "../screens/shop/ShopDetailScreen";
import ShopEditScreen from "../screens/shop/ShopEditScreen";
import ViewAllUsersScreen from "../screens/admin/ViewAllUsersScreen";
import UserDetailScreen from "../screens/admin/UserDetailScreen";
import EditUserScreen from "../screens/admin/EditUserScreen";
import { PAYMENT_STACK_SCREENS } from "./paymentScreens";
import type { PaymentStackParamList } from "./paymentStackTypes";

export type ProfileStackParamList = {
  ProfileHome: undefined;
  EditProfile: undefined;
  BookingHistory: undefined;
  BookingDetail: { bookingId: string };
  CancelBooking: { bookingId: string };
  RescheduleBooking: { bookingId: string };
  Notifications: undefined;
  LanguageSettings: undefined;
  SupportHelp: undefined;
  DeleteAccount: undefined;
  TermsPrivacy: undefined;
  LegalPolicies: undefined;
  PrivacyPolicy: undefined;
  TermsConditions: undefined;
  CancellationPolicy: undefined;
  PlatformFeeDisclosure: undefined;
  AuraDisclosure: undefined;
  BarberTerms: undefined;
  NotificationConsent: undefined;
  SecurityNotice: undefined;
  ScheduleControls: undefined;
  EditBarberSchedule: { barberId: string; barberName: string };
  BarberRoster: undefined;
  BarberDetail: { barberId: string; barberName: string };
  BarberEdit: { barberId: string; barberName: string };
  BarberServices: { barberId: string; barberName: string };
  EditService: { barberId: string; barberName: string; serviceId?: string };
  ShopRoster: undefined;
  ShopDetail: { businessId: string; shopName: string; isPlaceholder?: boolean };
  ShopEdit: { businessId: string; shopName: string; isPlaceholder?: boolean };
  ViewAllUsers: undefined;
  UserDetail: { userId: string };
  EditUser: { userId: string };
} & PaymentStackParamList;

const Stack = createStackNavigator<ProfileStackParamList>();

export default function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="ProfileHome" component={ProfileHomeScreen} />
      <Stack.Screen name="EditProfile" component={EditProfileScreen} />
      <Stack.Screen name="BookingHistory" component={BookingHistoryScreen} />
      <Stack.Screen name="BookingDetail" component={BookingDetailScreen} />
      <Stack.Screen name="CancelBooking" component={CancelBookingScreen} />
      <Stack.Screen name="RescheduleBooking" component={RescheduleBookingScreen} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
      <Stack.Screen name="LanguageSettings" component={LanguageSettingsScreen} />
      {PAYMENT_STACK_SCREENS.map(({ name, component }) => (
        <Stack.Screen key={name} name={name} component={component} />
      ))}
      <Stack.Screen name="SupportHelp" component={SupportHelpScreen} />
      <Stack.Screen name="DeleteAccount" component={DeleteAccountScreen} />
      <Stack.Screen name="TermsPrivacy" component={TermsPrivacyScreen} />
      <Stack.Screen name="LegalPolicies" component={LegalPoliciesIndexScreen} />
      <Stack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
      <Stack.Screen name="TermsConditions" component={TermsConditionsScreen} />
      <Stack.Screen name="CancellationPolicy" component={CancellationPolicyScreen} />
      <Stack.Screen name="PlatformFeeDisclosure" component={PlatformFeeDisclosureScreen} />
      <Stack.Screen name="AuraDisclosure" component={AuraDisclosureScreen} />
      <Stack.Screen name="BarberTerms" component={BarberTermsScreen} />
      <Stack.Screen name="NotificationConsent" component={NotificationConsentScreen} />
      <Stack.Screen name="SecurityNotice" component={SecurityNoticeScreen} />
      <Stack.Screen name="ScheduleControls">
        {() => <ScheduleControlsScreen />}
      </Stack.Screen>
      <Stack.Screen name="EditBarberSchedule">
        {() => (
          <ScheduleRouteGuard>
            <EditBarberScheduleScreen />
          </ScheduleRouteGuard>
        )}
      </Stack.Screen>
      <Stack.Screen name="BarberRoster" component={BarberRosterScreen} />
      <Stack.Screen name="BarberDetail" component={BarberDetailScreen} />
      <Stack.Screen name="BarberEdit" component={BarberEditScreen} />
      <Stack.Screen name="BarberServices" component={BarberServicesScreen} />
      <Stack.Screen name="EditService" component={EditServiceScreen} />
      <Stack.Screen name="ShopRoster" component={ShopRosterScreen} />
      <Stack.Screen name="ShopDetail" component={ShopDetailScreen} />
      <Stack.Screen name="ShopEdit" component={ShopEditScreen} />
      <Stack.Screen name="ViewAllUsers" component={ViewAllUsersScreen} />
      <Stack.Screen name="UserDetail" component={UserDetailScreen} />
      <Stack.Screen name="EditUser" component={EditUserScreen} />
    </Stack.Navigator>
  );
}
