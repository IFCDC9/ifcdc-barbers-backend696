import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import { ScreenLoading } from "../../components/LoadingState";
import SuperAdminRouteGuard from "../../components/SuperAdminRouteGuard";
import { useAuth } from "../../services/authContext";
import { isSuperAdminUser } from "../../utils/adminAccess";
import {
  createManualBypassBooking,
  searchManualBookingClients,
  type BypassPaymentType,
} from "../../services/manualBypassBookingApi";
import { apiFetch } from "../../services/api";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";
import type { AdminStackParamList } from "../../navigation/AdminStack";

type Nav = StackNavigationProp<AdminStackParamList, "AdminManualBooking">;

const PAYMENT_OPTIONS: { id: BypassPaymentType; title: string; subtitle: string }[] = [
  { id: "paid_online", title: "Paid Online", subtitle: "PayPal checkout · platform fee applies" },
  { id: "complimentary", title: "Complimentary", subtitle: "No charge · confirmation email sent" },
  { id: "pay_at_shop", title: "Pay at Shop", subtitle: "Confirmed · collect payment in person" },
  { id: "staff_training", title: "Staff / Training", subtitle: "Blocks calendar · no payment" },
];

function AdminManualBookingScreenInner() {
  const navigation = useNavigation<Nav>();
  const { user, token } = useAuth();
  const allowed = isSuperAdminUser(user, token);

  const [paymentType, setPaymentType] = useState<BypassPaymentType>("pay_at_shop");
  const [barbers, setBarbers] = useState<{ id: string; name: string }[]>([]);
  const [barberId, setBarberId] = useState("");
  const [barberName, setBarberName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [clientUserId, setClientUserId] = useState<string | null>(null);
  const [createClient, setCreateClient] = useState(true);
  const [clientQuery, setClientQuery] = useState("");
  const [clientHits, setClientHits] = useState<{ id: string; name: string; email: string }[]>([]);
  const [service, setService] = useState("Haircut");
  const [price, setPrice] = useState("35");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00 AM");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [enforceAvailability, setEnforceAvailability] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingBarbers, setLoadingBarbers] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/app-bookings/barbers");
        const json = await res.json().catch(() => ({}));
        const list = Array.isArray(json) ? json : json?.barbers || [];
        if (cancelled) return;
        const mapped = list
          .map((b: { id?: string; barberId?: string; name?: string; barberName?: string }) => ({
            id: String(b.id || b.barberId || ""),
            name: String(b.name || b.barberName || "Barber"),
          }))
          .filter((b: { id: string }) => b.id);
        setBarbers(mapped);
        if (mapped[0]) {
          setBarberId(mapped[0].id);
          setBarberName(mapped[0].name);
        }
      } catch (e) {
        if (!cancelled) Alert.alert("Barbers", userFacingApiError(e));
      } finally {
        if (!cancelled) setLoadingBarbers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (clientQuery.trim().length < 2) {
      setClientHits([]);
      return;
    }
    const t = setTimeout(() => {
      searchManualBookingClients(clientQuery.trim())
        .then((json) => setClientHits(Array.isArray(json?.clients) ? json.clients : []))
        .catch(() => setClientHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [clientQuery]);

  const selectedBarberLabel = useMemo(() => {
    return barbers.find((b) => b.id === barberId)?.name || barberName || "Select barber";
  }, [barbers, barberId, barberName]);

  const onSubmit = useCallback(async () => {
    if (!allowed) return;
    if (!barberId || !customerName.trim() || !customerEmail.trim() || !date || !time) {
      Alert.alert("Missing fields", "Barber, client name, email, date, and time are required.");
      return;
    }
    setBusy(true);
    try {
      const priceNum = Number(price);
      const result = await createManualBypassBooking({
        paymentType,
        barberId,
        barberName: selectedBarberLabel,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim().toLowerCase(),
        clientUserId,
        createClient: createClient && !clientUserId,
        service: service.trim() || "Appointment",
        price: Number.isFinite(priceNum) ? priceNum : 0,
        date,
        time,
        notes: notes.trim() || undefined,
        reason: reason.trim() || undefined,
        enforceAvailability,
      });
      if (!result?.ok) {
        const bits = [result?.message, result?.detail, result?.code ? `[${result.code}]` : ""]
          .map((x) => String(x || "").trim())
          .filter(Boolean);
        throw new Error(bits.join(" ") || "Could not create booking");
      }
      const bookingId = result.booking?.id;
      const approveUrl = result.paypal?.approveUrl;
      if (paymentType === "paid_online" && approveUrl) {
        Alert.alert("Checkout ready", "Open PayPal to complete payment for this client?", [
          { text: "Later", style: "cancel" },
          {
            text: "Open PayPal",
            onPress: () => {
              void Linking.openURL(String(approveUrl));
            },
          },
        ]);
      } else {
        Alert.alert("Booked", "Manual booking created and calendar updated.");
      }
      if (bookingId) {
        navigation.navigate("AdminBookingDetail", { bookingId: String(bookingId) });
      } else {
        navigation.goBack();
      }
    } catch (e) {
      Alert.alert("Booking failed", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  }, [
    allowed,
    barberId,
    customerName,
    customerEmail,
    date,
    time,
    paymentType,
    selectedBarberLabel,
    clientUserId,
    createClient,
    service,
    price,
    notes,
    reason,
    enforceAvailability,
    navigation,
  ]);

  if (!allowed) {
    return (
      <ProfileScreenLayout title="Book for Client">
        <Text style={styles.denied}>Super Admin only.</Text>
      </ProfileScreenLayout>
    );
  }

  if (loadingBarbers) {
    return (
      <ProfileScreenLayout title="Book for Client">
        <ScreenLoading message="Loading barbers…" />
      </ProfileScreenLayout>
    );
  }

  return (
    <ProfileScreenLayout title="Book for Client" subtitle="Manual Booking · Bypass Mode">
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>Payment type</Text>
        {PAYMENT_OPTIONS.map((opt) => {
          const active = paymentType === opt.id;
          return (
            <Pressable key={opt.id} onPress={() => setPaymentType(opt.id)} style={styles.optionWrap}>
              <ProfileCard style={[styles.option, active && styles.optionActive]}>
                <Text style={styles.optionTitle}>{opt.title}</Text>
                <Text style={styles.optionSub}>{opt.subtitle}</Text>
              </ProfileCard>
            </Pressable>
          );
        })}

        <Text style={styles.section}>Barber</Text>
        {barbers.map((b) => {
          const active = barberId === b.id;
          return (
            <Pressable
              key={b.id}
              onPress={() => {
                setBarberId(b.id);
                setBarberName(b.name);
              }}
              style={styles.optionWrap}
            >
              <ProfileCard style={[styles.option, active && styles.optionActive]}>
                <Text style={styles.optionTitle}>{b.name}</Text>
              </ProfileCard>
            </Pressable>
          );
        })}

        <Text style={styles.section}>Client</Text>
        <TextInput
          style={styles.input}
          placeholder="Search existing clients"
          placeholderTextColor={theme.colors.muted}
          value={clientQuery}
          onChangeText={setClientQuery}
          autoCapitalize="none"
        />
        {clientHits.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => {
              setClientUserId(c.id);
              setCustomerName(c.name || "");
              setCustomerEmail(c.email || "");
              setCreateClient(false);
              setClientQuery("");
              setClientHits([]);
            }}
            style={styles.optionWrap}
          >
            <ProfileCard style={styles.option}>
              <Text style={styles.optionTitle}>{c.name || c.email}</Text>
              <Text style={styles.optionSub}>{c.email}</Text>
            </ProfileCard>
          </Pressable>
        ))}
        <TextInput
          style={styles.input}
          placeholder="Client name"
          placeholderTextColor={theme.colors.muted}
          value={customerName}
          onChangeText={(v) => {
            setCustomerName(v);
            setClientUserId(null);
          }}
        />
        <TextInput
          style={styles.input}
          placeholder="Client email"
          placeholderTextColor={theme.colors.muted}
          autoCapitalize="none"
          keyboardType="email-address"
          value={customerEmail}
          onChangeText={(v) => {
            setCustomerEmail(v);
            setClientUserId(null);
            setCreateClient(true);
          }}
        />

        <Text style={styles.section}>Service & schedule</Text>
        <TextInput
          style={styles.input}
          placeholder="Service"
          placeholderTextColor={theme.colors.muted}
          value={service}
          onChangeText={setService}
        />
        <TextInput
          style={styles.input}
          placeholder="Price (USD)"
          placeholderTextColor={theme.colors.muted}
          keyboardType="decimal-pad"
          value={price}
          onChangeText={setPrice}
          editable={paymentType !== "complimentary" && paymentType !== "staff_training"}
        />
        <TextInput
          style={styles.input}
          placeholder="Date YYYY-MM-DD"
          placeholderTextColor={theme.colors.muted}
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Time HH:MM or 1:00 PM"
          placeholderTextColor={theme.colors.muted}
          value={time}
          onChangeText={setTime}
          autoCapitalize="characters"
        />
        <TextInput
          style={[styles.input, styles.notes]}
          placeholder="Appointment notes"
          placeholderTextColor={theme.colors.muted}
          value={notes}
          onChangeText={setNotes}
          multiline
        />
        <TextInput
          style={[styles.input, styles.notes]}
          placeholder="Bypass reason (audit)"
          placeholderTextColor={theme.colors.muted}
          value={reason}
          onChangeText={setReason}
          multiline
        />

        <Pressable
          onPress={() => setEnforceAvailability((v) => !v)}
          style={styles.optionWrap}
        >
          <ProfileCard style={[styles.option, enforceAvailability && styles.optionActive]}>
            <Text style={styles.optionTitle}>
              {enforceAvailability ? "Enforce availability: ON" : "Enforce availability: OFF"}
            </Text>
            <Text style={styles.optionSub}>
              Off = Bypass Mode (book any time). On = respect the barber schedule.
            </Text>
          </ProfileCard>
        </Pressable>

        <Pressable
          onPress={onSubmit}
          disabled={busy}
          style={({ pressed }) => [styles.submit, (pressed || busy) && styles.submitPressed]}
        >
          <Text style={styles.submitText}>{busy ? "Creating…" : "Create booking"}</Text>
        </Pressable>
      </ScrollView>
    </ProfileScreenLayout>
  );
}

export default function AdminManualBookingScreen() {
  return (
    <SuperAdminRouteGuard>
      <AdminManualBookingScreenInner />
    </SuperAdminRouteGuard>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16, paddingBottom: 40, gap: 8 },
  section: {
    marginTop: 12,
    marginBottom: 4,
    color: theme.colors.gold,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  optionWrap: { marginBottom: 6 },
  option: { padding: 12 },
  optionActive: { borderColor: theme.colors.gold, borderWidth: 1 },
  optionTitle: { color: theme.colors.text, fontWeight: "700", fontSize: 15 },
  optionSub: { color: theme.colors.muted, marginTop: 2, fontSize: 12 },
  input: {
    backgroundColor: "#141414",
    borderColor: "#333",
    borderWidth: 1,
    borderRadius: 10,
    color: theme.colors.text,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
  },
  notes: { minHeight: 72, textAlignVertical: "top" },
  submit: {
    marginTop: 12,
    backgroundColor: theme.colors.gold,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitPressed: { opacity: 0.75 },
  submitText: { color: "#111", fontWeight: "800", fontSize: 15 },
  denied: { color: theme.colors.muted, padding: 24, textAlign: "center" },
});
