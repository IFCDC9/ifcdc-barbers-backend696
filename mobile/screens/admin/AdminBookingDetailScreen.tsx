import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ScreenLoading } from "../../components/LoadingState";
import {
  NavigationProp,
  RouteProp,
  useFocusEffect,
  useNavigation,
  useRoute,
} from "@react-navigation/native";
import ProfileScreenLayout from "../../components/ProfileScreenLayout";
import ProfileCard from "../../components/ProfileCard";
import GlowButton from "../../components/GlowButton";
import BookingStatusBadge from "../../components/BookingStatusBadge";
import {
  deleteAdminBooking,
  fetchAdminBookingById,
  patchAdminBookingAction,
  refundAdminBooking,
  resendBookingConfirmation,
  type AdminBookingDetail,
} from "../../services/adminBookingApi";
import { convertManualBypassToPaid, cancelManualBypassBooking } from "../../services/manualBypassBookingApi";
import { useAuth } from "../../services/authContext";
import { isSuperAdminUser } from "../../utils/adminAccess";
import { maskPhoneForDisplay } from "../../utils/redactPii";
import {
  displayCustomerEmail,
  displayCustomerName,
  formatBookingDateTime,
  formatCreatedAt,
  formatMoney,
  paymentMethodDisplayLabel,
  paymentStatusHeadline,
} from "../../utils/bookingDisplay";
import {
  bookingPaymentDisplayStatus,
  canPerformBookingDestructiveOps,
  canShowRefundClientButton,
} from "../../utils/bookingOpsAccess";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { theme } from "../../constants/theme";
import type { AdminStackParamList } from "../../navigation/AdminStack";

export type AdminBookingDetailParams = { bookingId: string };

type DetailRoute = RouteProp<AdminStackParamList, "AdminBookingDetail">;

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} selectable>
        {value}
      </Text>
    </View>
  );
}

function paymentSummary(booking: AdminBookingDetail): string {
  const type = String(booking.payment_type || "full").replace(/_/g, " ");
  const deposit = Number(booking.deposit_amount);
  const paid = Number(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid);
  const balance =
    Number(booking.balance_due ?? booking.remaining_balance ?? 0);
  const platformFee = Number(booking.platform_fee);
  const payout = Number(booking.barber_payout_amount);
  const feeStatus = String(booking.platform_fee_status || "pending").replace(/_/g, " ");
  if (type.includes("deposit") && Number.isFinite(deposit) && deposit > 0) {
    const rem = balance > 0.01 ? ` · Balance due ${formatMoney(balance)}` : "";
    return `Deposit ${formatMoney(deposit)} · Charged ${formatMoney(paid)}${rem} · Platform fee ${formatMoney(platformFee)} (${feeStatus}) · Barber payout ${formatMoney(payout)}`;
  }
  return `Paid in full · Charged ${formatMoney(paid || booking.total_amount || booking.total_price)} · Platform fee ${formatMoney(platformFee)} (${feeStatus}) · Barber payout ${formatMoney(payout)}`;
}

function paymentStatusLabel(booking: AdminBookingDetail): string {
  return bookingPaymentDisplayStatus(booking).replace(/_/g, " ");
}

export default function AdminBookingDetailScreen() {
  const route = useRoute<DetailRoute>();
  const navigation = useNavigation<NavigationProp<AdminStackParamList>>();
  const { bookingId } = route.params;
  const { user, token } = useAuth();

  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState<AdminBookingDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"complete" | "cancel" | "resend" | null>(null);

  const canDestructive = canPerformBookingDestructiveOps(user, token);
  const isSuperAdmin = isSuperAdminUser(user, token);
  const showRefund = useMemo(
    () => Boolean(booking && canDestructive && canShowRefundClientButton(booking)),
    [booking, canDestructive],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBooking(await fetchAdminBookingById(bookingId));
    } catch (e) {
      Alert.alert("Booking", userFacingApiError(e));
      setBooking(null);
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const runAction = (
    title: string,
    message: string,
    action: "complete" | "cancel",
  ) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm",
        style: action === "cancel" ? "destructive" : "default",
        onPress: async () => {
          setBusy(true);
          setActionBusy(action);
          try {
            if (action === "cancel" && booking?.manual_bypass) {
              await cancelManualBypassBooking(bookingId);
              Alert.alert("Updated", "Bypass booking cancelled.");
            } else {
              const result = await patchAdminBookingAction(bookingId, action);
              if (result.booking) {
                setBooking((prev) => ({
                  ...(prev || {}),
                  ...result.booking,
                  booking_status:
                    (result.booking as { booking_status?: string }).booking_status ||
                    (action === "complete" ? "completed" : prev?.booking_status),
                }));
              }
              Alert.alert("Updated", result.message);
            }
            await load();
          } catch (e) {
            Alert.alert("Action failed", userFacingApiError(e));
          } finally {
            setBusy(false);
            setActionBusy(null);
          }
        },
      },
    ]);
  };

  const onRefundClient = () => {
    if (!booking) return;
    if (!canShowRefundClientButton(booking)) {
      Alert.alert(
        "Refund unavailable",
        "Refund unavailable: no payment transaction found.",
      );
      return;
    }
    Alert.alert(
      "Refund Client",
      `Issue a PayPal refund of ${formatMoney(
        booking.amount_charged ?? booking.amount_paid ?? booking.total_paid,
      )}? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Refund via PayPal",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              const result = await refundAdminBooking(bookingId, { reason: "Admin refund" });
              if (result.booking) {
                setBooking((prev) => ({ ...(prev || {}), ...result.booking }));
              }
              Alert.alert("Refund processed", result.message);
              void load();
            } catch (e) {
              Alert.alert("Refund failed", userFacingApiError(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const onDeleteBooking = () => {
    Alert.alert(
      "Delete this booking permanently?",
      "This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Confirm permanent delete",
              "The booking will be removed from schedules, customer history, and admin lists.",
              [
                { text: "Go back", style: "cancel" },
                {
                  text: "Delete permanently",
                  style: "destructive",
                  onPress: async () => {
                    setBusy(true);
                    try {
                      const result = await deleteAdminBooking(bookingId, "Admin delete");
                      Alert.alert("Deleted", result.message, [
                        {
                          text: "OK",
                          onPress: () => navigation.goBack(),
                        },
                      ]);
                    } catch (e) {
                      Alert.alert("Delete failed", userFacingApiError(e));
                    } finally {
                      setBusy(false);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  const onResend = async () => {
    setBusy(true);
    setActionBusy("resend");
    try {
      const message = await resendBookingConfirmation(bookingId);
      Alert.alert("Confirmation", message);
    } catch (e) {
      Alert.alert("Confirmation", userFacingApiError(e));
    } finally {
      setBusy(false);
      setActionBusy(null);
    }
  };

  const onContact = () => {
    if (!booking) return;
    const email = displayCustomerEmail(booking.customer_email);
    if (email === "Guest customer" || email === "No email on file") {
      Alert.alert("Contact customer", "No customer email is available for this booking.");
      return;
    }
    const subject = encodeURIComponent(`IFCDC Barbers — appointment ${bookingId.slice(0, 8)}`);
    Linking.openURL(`mailto:${email}?subject=${subject}`).catch(() => {
      Alert.alert("Contact customer", email);
    });
  };

  if (loading) {
    return (
      <ProfileScreenLayout title="Booking detail" subtitle="Admin console">
        <ScreenLoading />
      </ProfileScreenLayout>
    );
  }

  if (!booking) {
    return (
      <ProfileScreenLayout title="Booking detail" subtitle="Admin console">
        <Text style={styles.muted}>Booking not found.</Text>
      </ProfileScreenLayout>
    );
  }

  const onConvertBypassPaid = () => {
    Alert.alert("Mark paid", "Record payment received for this bypass booking?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Mark paid",
        onPress: async () => {
          setBusy(true);
          try {
            await convertManualBypassToPaid(bookingId, "mark_paid");
            Alert.alert("Updated", "Booking marked paid.");
            await load();
          } catch (e) {
            Alert.alert("Update failed", userFacingApiError(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const customerEmail = displayCustomerEmail(booking.customer_email);
  const appointmentWhen = formatBookingDateTime(booking.date, booking.time, booking.created_at);
  const notes =
    booking.style_title && booking.style_title !== booking.service
      ? `Style: ${booking.style_title}`
      : "—";

  return (
    <ProfileScreenLayout title="Booking detail" subtitle="Admin console" headerTopPad={12}>
      <ProfileCard style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroCopy}>
            <Text style={styles.service}>{booking.service || booking.style_title || "Appointment"}</Text>
            <Text style={styles.when}>{appointmentWhen}</Text>
          </View>
          <BookingStatusBadge paymentStatus={booking.payment_status} bookingStatus={booking.booking_status} />
        </View>
        <Text style={styles.total}>{formatMoney(booking.total_amount ?? booking.total_price)}</Text>
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>Customer</Text>
        <MetaRow label="Name" value={displayCustomerName(booking.customer_name, booking.customer_email)} />
        <MetaRow label="Email" value={customerEmail} />
        {booking.phone ? (
          <MetaRow label="Phone" value={maskPhoneForDisplay(String(booking.phone))} />
        ) : null}
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>Appointment</Text>
        <MetaRow label="Booking ID" value={String(booking.id)} />
        <MetaRow label="Barber" value={booking.barber_name || "—"} />
        <MetaRow label="Service" value={booking.service || booking.style_title || "—"} />
        <MetaRow label="Scheduled" value={appointmentWhen} />
        <MetaRow label="Booking status" value={String(booking.booking_status || "confirmed").replace(/_/g, " ")} />
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>Payment</Text>
        <MetaRow label="Payment status" value={paymentStatusLabel(booking)} />
        <MetaRow
          label="Settlement"
          value={paymentStatusHeadline(
            booking.payment_status,
            Number((booking as { balance_due?: number | string | null }).balance_due ?? booking.remaining_balance),
            Number(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid),
          )}
        />
        <MetaRow
          label="Service price"
          value={formatMoney(
            (booking as { service_price?: number | string | null }).service_price ??
              booking.total_price ??
              (booking as { amount?: number | string | null }).amount,
          )}
        />
        <MetaRow label="Platform fee" value={formatMoney(booking.platform_fee)} />
        <MetaRow label="Tip" value={formatMoney(booking.tip_amount)} />
        <MetaRow
          label="Charged today"
          value={formatMoney(booking.amount_charged ?? booking.amount_paid ?? booking.total_paid)}
        />
        <MetaRow
          label="Balance due"
          value={formatMoney(
            (booking as { balance_due?: number }).balance_due ?? booking.remaining_balance ?? 0,
          )}
        />
        <MetaRow
          label="Method"
          value={paymentMethodDisplayLabel(
            (booking as { payment_method?: string }).payment_method,
            booking.payment_provider,
          )}
        />
        <MetaRow
          label="Barber payout"
          value={formatMoney(booking.barber_payout_amount)}
        />
        <MetaRow
          label="Platform fee status"
          value={String(booking.platform_fee_status || "pending").replace(/_/g, " ")}
        />
        <MetaRow label="Summary" value={paymentSummary(booking)} />
        <MetaRow label="Provider" value={booking.payment_provider || "—"} />
        <MetaRow label="PayPal order" value={booking.paypal_order_id || "—"} />
        {booking.paypal_capture_id ||
        (booking as { stripe_payment_intent_id?: string }).stripe_payment_intent_id ? (
          <MetaRow
            label="PayPal ref"
            value={
              booking.paypal_capture_id ||
              (booking as { stripe_payment_intent_id?: string }).stripe_payment_intent_id ||
              "—"
            }
          />
        ) : null}
        {!showRefund && canDestructive ? (
          <Text style={styles.refundUnavailable}>
            Refund unavailable: no payment transaction found.
          </Text>
        ) : null}
      </ProfileCard>

      {booking.manual_bypass ? (
        <ProfileCard style={styles.section}>
          <Text style={styles.sectionTitle}>Manual Bypass Audit</Text>
          <MetaRow
            label="Payment type"
            value={String(booking.bypass_payment_type || "—").replace(/_/g, " ")}
          />
          <MetaRow label="Created by" value={booking.bypass_created_by_email || "Super Admin"} />
          <MetaRow
            label="Created at"
            value={
              booking.bypass_created_at
                ? formatCreatedAt(booking.bypass_created_at)
                : formatCreatedAt(booking.created_at)
            }
          />
          <MetaRow label="Barber" value={booking.barber_name || "—"} />
          <MetaRow
            label="Client"
            value={displayCustomerName(booking.customer_name, booking.customer_email)}
          />
          <MetaRow label="Bypass reason" value={booking.bypass_reason || "—"} />
          <MetaRow
            label="Appointment notes"
            value={booking.appointment_notes || booking.notes || "—"}
          />
        </ProfileCard>
      ) : null}

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        <MetaRow label="Details" value={notes} />
        <MetaRow label="Created" value={formatCreatedAt(booking.created_at)} />
      </ProfileCard>

      <View style={styles.actions}>
        {isSuperAdmin &&
        booking.manual_bypass &&
        ["complimentary", "pay_at_shop", "staff_training"].includes(
          String(booking.bypass_payment_type || "").toLowerCase(),
        ) ? (
          <GlowButton
            label="Convert to Paid"
            onPress={onConvertBypassPaid}
            disabled={busy}
          />
        ) : null}
        <GlowButton
          label="Mark complete"
          onPress={() =>
            runAction("Mark complete", "Mark this appointment as completed?", "complete")
          }
          disabled={busy}
          loading={actionBusy === "complete"}
        />
        <View style={styles.actionRow}>
          <GlowButton
            label="Resend confirmation"
            variant="outline"
            size="compact"
            onPress={() => void onResend()}
            disabled={busy}
            loading={actionBusy === "resend"}
            style={styles.actionHalf}
            fullWidth={false}
          />
          <GlowButton
            label="Contact customer"
            variant="outline"
            size="compact"
            onPress={onContact}
            disabled={busy}
            style={styles.actionHalf}
            fullWidth={false}
          />
        </View>
        {(isSuperAdmin || !booking.manual_bypass) ? (
          <GlowButton
            label="Cancel booking"
            variant="secondary"
            size="compact"
            onPress={() =>
              runAction("Cancel booking", "Cancel this appointment? The record stays in admin history.", "cancel")
            }
            disabled={busy}
          />
        ) : null}

        {canDestructive ? (
          <View style={styles.destructiveRow}>
            {showRefund ? (
              <GlowButton
                label="Refund Client"
                variant="secondary"
                size="compact"
                onPress={onRefundClient}
                disabled={busy}
                loading={busy}
                style={styles.actionHalf}
                fullWidth={false}
              />
            ) : null}
            <GlowButton
              label="Delete Booking"
              variant="danger"
              size="compact"
              onPress={onDeleteBooking}
              disabled={busy}
              style={showRefund ? styles.actionHalf : styles.actionFull}
              fullWidth={!showRefund}
            />
          </View>
        ) : null}
      </View>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  muted: { color: theme.colors.textMuted, textAlign: "center", marginTop: 24, fontSize: 15 },
  hero: { gap: 10, paddingVertical: 16 },
  heroTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  heroCopy: { flex: 1, gap: 4 },
  service: { color: theme.colors.gold, fontSize: 20, fontWeight: "800" },
  when: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 20 },
  total: { color: theme.colors.text, fontSize: 22, fontWeight: "800" },
  section: { gap: 2 },
  sectionTitle: {
    color: theme.colors.gold,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  metaLabel: { color: theme.colors.textMuted, fontSize: 14, flex: 1 },
  metaValue: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
    maxWidth: "58%",
    textAlign: "right",
  },
  refundUnavailable: {
    color: theme.colors.textMuted,
    fontSize: 13,
    marginTop: 10,
    fontStyle: "italic",
  },
  actions: { gap: 10, marginTop: 4, marginBottom: 8 },
  actionRow: { flexDirection: "row", gap: 10 },
  destructiveRow: { flexDirection: "row", gap: 10, marginTop: 2 },
  actionHalf: { flex: 1, width: undefined },
  actionFull: { width: "100%" },
});
