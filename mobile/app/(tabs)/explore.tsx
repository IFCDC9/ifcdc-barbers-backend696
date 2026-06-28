import React from "react"
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { useNavigation } from "@react-navigation/native"
import type { NavigationProp, ParamListBase } from "@react-navigation/native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import CardContainer from "../../components/CardContainer"
import DarkGradientBackground from "../../components/DarkGradientBackground"
import GlowButton from "../../components/GlowButton"
import { palette, typography, ui } from "../../constants/theme"
import { IFCDC_FOOTER_CLEARANCE } from "../../constants/profileLayout"

const HORIZONTAL_PAD = 24

const ExploreScreen = () => {
  const navigation = useNavigation<NavigationProp<ParamListBase>>()
  const insets = useSafeAreaInsets()
  const { width: screenWidth } = useWindowDimensions()
  const { t } = useTranslation()

  const brandFontSize = screenWidth < 340 ? 11 : screenWidth < 375 ? 12 : 13
  const brandLetterSpacing = screenWidth < 340 ? 0.6 : screenWidth < 375 ? 1 : 1.4

  return (
    <View style={styles.root}>
      <DarkGradientBackground />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 20, paddingBottom: Math.max(insets.bottom, 16) + IFCDC_FOOTER_CLEARANCE + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerBlock}>
          <Text
            style={[
              styles.brand,
              { fontSize: brandFontSize, letterSpacing: brandLetterSpacing },
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.82}
          >
            IFCDC BARBERS
          </Text>
          <Text style={styles.tagline}>{t("home.tagline")}</Text>
        </View>

        <CardContainer glow style={styles.heroCard}>
          <Text style={styles.heroTitle}>{t("home.heroTitle")}</Text>
          <Text style={styles.heroCopy}>{t("home.heroCopy")}</Text>
          <GlowButton label={t("home.heroCta")} onPress={() => navigation.navigate("Book")} />
          <View style={{ height: 10 }} />
          <GlowButton
            label="Discover haircuts"
            variant="outline"
            onPress={() => navigation.navigate("Book", { screen: "StyleDiscover" })}
          />
        </CardContainer>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: HORIZONTAL_PAD,
    gap: 20,
  },
  headerBlock: {
    width: "100%",
    maxWidth: "100%",
    flexShrink: 1,
    gap: 6,
  },
  brand: {
    ...typography.brand,
    flexShrink: 1,
    width: "100%",
    maxWidth: "100%",
  },
  tagline: {
    ...typography.bodyMuted,
    flexShrink: 1,
  },
  heroCard: {
    padding: 28,
    marginTop: 12,
  },
  heroTitle: {
    ...ui.screenTitle,
    fontSize: 26,
    marginBottom: 12,
  },
  heroCopy: {
    ...ui.screenSubtitle,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 22,
  },
})

export default ExploreScreen
