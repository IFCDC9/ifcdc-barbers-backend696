/**
 * IFCDC Barbers — BUILD 22 lazy-mount root.
 *
 * Build 21 proved the entry chain (AppEntry.js → App.tsx) is healthy by
 * rendering only `react` + `react-native` core. Build 22 adds back the
 * real provider tree (SafeAreaProvider, AuthProvider, NavigationContainer,
 * Login, Register, Password Reset, Dashboard shell) — but does so by
 * lazily `require()`-ing AppRoot.tsx inside try/catch. If any heavy import
 * in AppRoot's transitive chain throws at module-load time (the suspected
 * cause of the Build 18-20 black screens — boundaries cannot catch
 * module-load errors, only render errors), App.tsx catches it and renders
 * "System Recovery Mode" with the actual error, instead of a silent
 * black surface.
 *
 * Architectural rules for Build 22 (do NOT regress):
 *   - This file imports ONLY `react` and `react-native` core. Anything
 *     heavier goes in AppRoot.tsx so it can be safely lazy-loaded.
 *   - The first paint is "IFCDC ROOT LOADED" — same as Build 21, so even
 *     if AppRoot fails to evaluate, the user sees branded text immediately.
 *   - Recovery Mode shows the failed stage + error message + stack so
 *     TestFlight testers can read it back to support.
 */

import React from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

const BUILD_LABEL = "BUILD 26";

if (__DEV__) console.log("[startup] ROOT START", {
  buildLabel: BUILD_LABEL,
  platform: Platform.OS,
  version: String(Platform.Version),
  ts: new Date().toISOString(),
});

type Phase =
  | { kind: "boot" }
  | { kind: "ready"; AppRoot: React.ComponentType }
  | { kind: "recovery"; stage: string; error: string };

type TopBoundaryProps = {
  children: React.ReactNode;
  onError: (error: Error) => void;
};

class TopBoundary extends React.Component<TopBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      "[startup] TopBoundary caught render error:",
      error?.message,
      info?.componentStack,
    );
    this.props.onError(error);
  }

  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

export default function App() {
  const [phase, setPhase] = React.useState<Phase>({ kind: "boot" });

  React.useEffect(() => {
    let cancelled = false;
    // Defer the heavy require by one tick so the ROOT START frame paints
    // first — gives TestFlight users immediate feedback even on slow devices,
    // and lets Hermes finish JS init before we add load.
    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("./AppRoot");
        const Component: React.ComponentType = mod?.default ?? mod;
        if (typeof Component !== "function") {
          throw new Error("AppRoot: default export is not a React component");
        }
        console.log("[startup] AppRoot module evaluated successfully");
        setPhase({ kind: "ready", AppRoot: Component });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error && e.stack ? e.stack : "";
        console.error("[startup] AppRoot module-load FAILED:", message, stack);
        setPhase({
          kind: "recovery",
          stage: "module-load (AppRoot.tsx)",
          error: stack ? `${message}\n\n${stack}` : message,
        });
      }
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (phase.kind === "boot") return <RootStartScreen />;
  if (phase.kind === "recovery") {
    return <SystemRecoveryScreen stage={phase.stage} error={phase.error} />;
  }

  const { AppRoot } = phase;
  return (
    <TopBoundary
      onError={(e) =>
        setPhase({
          kind: "recovery",
          stage: "render (top boundary)",
          error: String(e?.message || e),
        })
      }
    >
      <AppRoot />
    </TopBoundary>
  );
}

function RootStartScreen() {
  return (
    <View style={styles.bootRoot}>
      <Text style={styles.title}>IFCDC ROOT LOADED {BUILD_LABEL}</Text>
      <Text style={styles.subtitle}>React mounted successfully</Text>
      <View style={styles.divider} />
      <Text style={styles.info}>
        {Platform.OS} {String(Platform.Version)}
      </Text>
      <Text style={styles.hint}>Loading real app…</Text>
    </View>
  );
}

function SystemRecoveryScreen({
  stage,
  error,
}: {
  stage: string;
  error: string;
}) {
  console.log("[startup] SYSTEM RECOVERY MODE", { stage });
  return (
    <View style={styles.recoveryRoot}>
      <ScrollView contentContainerStyle={styles.recoveryScroll}>
        <Text style={styles.recoveryTitle}>System Recovery Mode</Text>
        <Text style={styles.subtitle}>{BUILD_LABEL}</Text>
        <View style={styles.divider} />
        <Text style={styles.recoveryLabel}>Failed at</Text>
        <Text style={styles.recoveryBody} selectable>
          {stage}
        </Text>
        <Text style={styles.recoveryLabel}>Error</Text>
        <Text style={styles.recoveryBody} selectable>
          {error}
        </Text>
        <Text style={styles.recoveryLabel}>Platform</Text>
        <Text style={styles.recoveryBody} selectable>
          {Platform.OS} {String(Platform.Version)}
        </Text>
        <Text style={styles.hint}>
          The IFCDC Barbers app couldn't bring up its real flow. Please share
          this screen with support so the issue can be patched.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bootRoot: {
    flex: 1,
    backgroundColor: "#0b0b0b",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "#F5C842",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 1.2,
    marginBottom: 14,
  },
  subtitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  divider: {
    width: 120,
    height: 1,
    backgroundColor: "rgba(245,200,66,0.45)",
    marginVertical: 22,
  },
  info: {
    color: "#bdbdbd",
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  hint: {
    color: "#888",
    fontSize: 11,
    marginTop: 28,
    textAlign: "center",
    lineHeight: 16,
    maxWidth: 320,
  },
  recoveryRoot: { flex: 1, backgroundColor: "#0b0b0b" },
  recoveryScroll: { padding: 24, paddingTop: 72 },
  recoveryTitle: {
    color: "#F5C842",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 1.0,
    marginBottom: 8,
    textAlign: "center",
  },
  recoveryLabel: {
    color: "#F5C842",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    marginTop: 16,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  recoveryBody: { color: "#fff", fontSize: 13, lineHeight: 19 },
});
