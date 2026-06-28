import React from "react";
import { createStackNavigator } from "@react-navigation/stack";
import BookingScreen from "../screens/BookingScreen";
import BarberPortfolioScreen, {
  type BarberPortfolioParams,
} from "../screens/portfolio/BarberPortfolioScreen";

export type BookStackParamList = {
  BookMain: undefined;
  BarberPortfolio: BarberPortfolioParams;
};

const Stack = createStackNavigator<BookStackParamList>();

export default function BookStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="BookMain" component={BookingScreen} />
      <Stack.Screen name="BarberPortfolio" component={BarberPortfolioScreen} />
    </Stack.Navigator>
  );
}
