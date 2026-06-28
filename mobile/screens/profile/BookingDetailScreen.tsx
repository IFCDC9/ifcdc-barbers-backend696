import React, { useCallback, useMemo, useState } from "react";
import { Alert, Linking, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
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
  fetchBookingById,
  removeBookingFromHistory,
  type BookingDetail,
} from "../../services/bookingDetailApi";
import {
  deleteAdminBooking,
  patchAdminBookingAction,
  refundAdminBooking,
  resendBookingConfirmation,
} from "../../services/adminBookingApi";
import {
  canPerformBookingDestructiveOps,
  canShowRefundClientButton,
  bookingRemovalBlockedMessage,
  canUserRemoveBookingFromHistory,
} from "../../utils/bookingOpsAccess";
import { confirmDelete } from "../../utils/confirmDelete";
import {
  BOOKING_STATUSES,
  canRoleTransition,
  fetchStatusHistory,
  isFinalStatus,
  setBookingStatus,
  type BookingStatus,
  type BookingStatusHistoryRow,
} from "../../services/bookingStatusApi";
import {
  bookingStatusTone,
  displayCustomerEmail,
  displayCustomerName,
  formatBookingDateTime,
  formatCreatedAt,
  formatMoney,
  paymentStatusHeadline,
  rawBookingStatusLabel,
} from "../../utils/bookingDisplay";
import { userFacingApiError } from "../../utils/userFacingApiError";
import { useAuth } from "../../services/authContext";
import { theme } from "../../constants/theme";
import ShareButton from "../../components/ShareButton";
import {
  deleteCustomerReview,
  fetchBookingReviewStatus,
  fetchFollowupReminders,
} from "../../services/socialPortfolioApi";
import {
  APP_BRAND_NAME,
  buildBookingShareMessage,
  buildReceiptShareMessage,
} from "../../utils/shareContent";

export type BookingDetailParams = { bookingId: string };

type Route = RouteProp<{ BookingDetail: BookingDetailParams }, "BookingDetail">;

type ActorRole = "super_admin" | "admin" | "shop_owner" | "barber" | "customer";

const DESTRUCTIVE_TARGETS: ReadonlyArray<BookingStatus> = [
  "cancelled",
  "no_show",
  "rescheduled",
];

function resolveActorRole(role?: string): ActorRole {
  const r = String(role || "").toLowerCase();
  if (r === "super_admin" || r === "admin" || r === "shop_owner" || r === "barber") return r;
  return "customer";
}

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

function paymentMethodLabel(b: BookingDetail): string {
  const provider = String(b.payment_provider || "").trim().toLowerCase();
  const type = String(b.payment_type || "").trim().toLowerCase();
  if (provider === "paypal") return type === "deposit" ? "PayPal · Deposit" : "PayPal";
  if (type === "pay_in_person" || type === "in_person") return "Pay in person";
  if (type) return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (provider) return provider.replace(/\b\w/g, (c) => c.toUpperCase());
  return "—";
}

function paymentBreakdown(b: BookingDetail): string {
  const type = String(b.payment_type || "full").replace(/_/g, " ");
  const deposit = Number(b.deposit_amount);
  const paid = Number(b.amount_paid ?? b.total_paid);
  const remaining = Number(b.remaining_balance);
  if (type.includes("deposit") && Number.isFinite(deposit) && deposit > 0) {
    const rem = Number.isFinite(remaining) ? ` · Balance ${formatMoney(remaining)}` : "";
    return `Deposit ${formatMoney(deposit)} · Paid ${formatMoney(paid)}${rem}`;
  }
  return `Full payment · ${formatMoney(paid || b.total_amount || b.total_price)}`;
}

function servicePriceFor(b: BookingDetail): string {
  return formatMoney(b.total_price ?? b.amount);
}

function formatTimelineDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function describeActor(row: BookingStatusHistoryRow): string {
  const role = String(row.changed_by_role || "").trim();
  const email = String(row.changed_by_email || "").trim();
  if (row.synthetic) return "system";
  if (email && role) return `${role.replace(/_/g, " ")} · ${email}`;
  if (email) return email;
  if (role) return role.replace(/_/g, " ");
  return "—";
}

function StatusTimeline({
  history,
  bookingCreatedAt,
  currentStatus,
}: {
  history: BookingStatusHistoryRow[];
  bookingCreatedAt?: string;
  currentStatus?: string;
}) {
  const { t } = useTranslation();
  const rows: BookingStatusHistoryRow[] = useMemo(() => {
    if (history.length === 0 && bookingCreatedAt && currentStatus) {
      return [
        {
          id: null,
          previous_status: null,
          new_status: currentStatus,
          changed_by_role: "system",
          changed_at: bookingCreatedAt,
          note: t("booking.details.initialBooking"),
          synthetic: true,
        },
      ];
    }
    return history;
  }, [history, bookingCreatedAt, currentStatus, t]);

  if (rows.length === 0) {
    return <Text style={styles.muted}>{t("booking.details.timelineEmpty")}</Text>;
  }

  return (
    <View style={timelineStyles.column}>
      {rows.map((row, idx) => {
        const tone = bookingStatusTone(undefined, row.new_status);
        return (
          <View key={String(row.id ?? `s-${idx}`)} style={timelineStyles.row}>
            <View style={timelineStyles.dotCol}>
              <View
                style={[
                  timelineStyles.dot,
                  tone === "paid" && timelineStyles.dotPaid,
                  tone === "active" && timelineStyles.dotActive,
                  tone === "pending" && timelineStyles.dotPending,
                  tone === "cancelled" && timelineStyles.dotCancelled,
                  tone === "noshow" && timelineStyles.dotNoshow,
                  tone === "rescheduled" && timelineStyles.dotResched,
                ]}
              />
              {idx < rows.length - 1 ? <View style={timelineStyles.line} /> : null}
            </View>
            <View style={timelineStyles.copyCol}>
              <Text style={timelineStyles.statusLine}>
                {rawBookingStatusLabel(row.new_status)}
              </Text>
              <Text style={timelineStyles.metaLine}>{formatTimelineDate(row.changed_at)}</Text>
              <Text style={timelineStyles.metaLine}>{t("booking.details.by")} {describeActor(row)}</Text>
              {row.note ? <Text style={timelineStyles.note}>{row.note}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

type NavParams = {
  CancelBooking: { bookingId: string };
  RescheduleBooking: { bookingId: string };
  BookingReview: {
    bookingId: string;
    barberId: string;
    barberName: string;
    serviceName?: string;
    followupReviewId?: string;
    is30DayFollowup?: boolean;
    editReviewId?: string;
    initialRating?: number;
    initialComment?: string;
  };
  BarberPortfolio: { slugOrId: string; barberName?: string };
  HaircutFollowup: undefined;
};

export default function BookingDetailScreen() {
  const route = useRoute<Route>();
  const navigation = useNavigation<NavigationProp<NavParams>>();
  const { bookingId } = route.params;
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const role = resolveActorRole(user?.role);
  // Customer-facing subtitles are translated; staff/admin subtitles are kept
  // in English (operational consoles per Phase 2 directive).
  const subtitle =
    role === "customer"
      ? t("booking.details.subtitleCustomer")
      : role === "barber"
        ? t("booking.details.subtitleBarber")
        : role === "shop_owner"
          ? t("booking.details.subtitleShop")
          : t("booking.details.subtitleAdmin");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [history, setHistory] = useState<BookingStatusHistoryRow[]>([]);
  const [canReview, setCanReview] = useState(false);
  const [hasReview, setHasReview] = useState(false);
  const [canEditReview, setCanEditReview] = useState(false);
  const [canDeleteReview, setCanDeleteReview] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reviewRating, setReviewRating] = useState<number | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [followupDue, setFollowupDue] = useState(false);
  const [followupReviewId, setFollowupReviewId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, timeline] = await Promise.all([
        fetchBookingById(bookingId),
        fetchStatusHistory(bookingId).catch(() => []),
      ]);
      setBooking(detail);
      setHistory(timeline);

      setCanReview(false);
      setHasReview(false);
      setCanEditReview(false);
      setCanDeleteReview(false);
      setReviewId(null);
      setReviewRating(null);
      setReviewComment("");
      setFollowupDue(false);
      setFollowupReviewId(null);

      if (
        resolveActorRole(user?.role) === "customer" &&
        String(detail?.booking_status || "").toLowerCase() === "completed"
      ) {
        const [reviewStatus, followups] = await Promise.all([
          fetchBookingReviewStatus(bookingId).catch(() => null),
          fetchFollowupReminders().catch(() => []),
        ]);
        if (reviewStatus) {
          setCanReview(Boolean(reviewStatus.canReview));
          setHasReview(Boolean(reviewStatus.hasReview));
          setCanEditReview(Boolean(reviewStatus.canEdit));
          setCanDeleteReview(Boolean(reviewStatus.canDelete));
          setReviewId(reviewStatus.reviewId);
          setReviewRating(reviewStatus.rating ?? null);
          setReviewComment(reviewStatus.comment || "");
        }
        const match = followups.find((f) => f.bookingId === bookingId && (f.due || f.status === "sent"));
        if (match) {
          setFollowupDue(true);
          setFollowupReviewId(match.reviewId);
        }
      }
    } catch (e) {
      Alert.alert("Booking", userFacingApiError(e));
      setBooking(null);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [bookingId, user?.role]);

  const onEditReview = useCallback(() => {
    if (!booking || !reviewId) return;
    navigation.navigate("BookingReview", {
      bookingId,
      barberId: String(booking.barber_id || ""),
      barberName: booking.barber_name || "Barber",
      serviceName: booking.service || booking.style_title || undefined,
      editReviewId: reviewId,
      initialRating: reviewRating ?? undefined,
      initialComment: reviewComment || undefined,
    });
  }, [booking, bookingId, navigation, reviewComment, reviewId, reviewRating]);

  const onDeleteReview = useCallback(() => {
    if (!reviewId) return;
    Alert.alert("Delete review", "Remove your review from this appointment? This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteCustomerReview(reviewId)
            .then(() => {
              Alert.alert("Review deleted", "You can leave a new review for this appointment.");
              void load();
            })
            .catch((e) => Alert.alert("Could not delete", userFacingApiError(e)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }, [load, reviewId]);

  const onOpenReview = useCallback(() => {
    if (!booking) return;
    navigation.navigate("BookingReview", {
      bookingId,
      barberId: String(booking.barber_id || ""),
      barberName: booking.barber_name || "Barber",
      serviceName: booking.service || booking.style_title || undefined,
    });
  }, [booking, bookingId, navigation]);

  const onOpenFollowup = useCallback(() => {
    if (!booking) return;
    navigation.navigate("BookingReview", {
      bookingId,
      barberId: String(booking.barber_id || ""),
      barberName: booking.barber_name || "Barber",
      serviceName: booking.service || booking.style_title || undefined,
      followupReviewId: followupReviewId || undefined,
      is30DayFollowup: true,
    });
  }, [booking, bookingId, followupReviewId, navigation]);

  const onViewBarberPortfolio = useCallback(() => {
    if (!booking?.barber_id) return;
    navigation.navigate("BarberPortfolio", {
      slugOrId: String(booking.barber_id),
      barberName: booking.barber_name || undefined,
    });
  }, [booking, navigation]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const currentStatus = useMemo(
    () => String(booking?.booking_status || "").toLowerCase(),
    [booking?.booking_status],
  );

  const isOverride = role === "super_admin" || role === "admin";
  const inFinalState = isFinalStatus(currentStatus);

  // The dedicated Reschedule + Cancel buttons handle these — exclude them from
  // the inline status grid so the same action isn't shown twice.
  const HANDLED_BY_DEDICATED_BUTTONS: ReadonlyArray<BookingStatus> = useMemo(
    () => ["cancelled", "rescheduled"],
    [],
  );

  const canCancelHere = useMemo(() => {
    if (!booking || inFinalState) return false;
    return canRoleTransition(role, currentStatus, "cancelled");
  }, [booking, inFinalState, role, currentStatus]);

  const canRescheduleHere = useMemo(() => {
    if (!booking || inFinalState) return false;
    if (isOverride) return true;
    return (
      canRoleTransition(role, currentStatus, "rescheduled") ||
      canRoleTransition(role, currentStatus, "confirmed")
    );
  }, [booking, inFinalState, isOverride, role, currentStatus]);

  /** Buttons surfaced for the current state, in the order we want them shown. */
  const statusActions = useMemo<
    Array<{ status: BookingStatus; label: string; destructive?: boolean }>
  >(() => {
    if (!booking) return [];
    const candidates: Array<{ status: BookingStatus; label: string; destructive?: boolean }> = [];

    const add = (status: BookingStatus, label: string, destructive?: boolean) => {
      if (HANDLED_BY_DEDICATED_BUTTONS.includes(status)) return;
      if (canRoleTransition(role, currentStatus, status)) {
        candidates.push({ status, label, destructive });
      }
    };

    if (role === "customer") {
      // Customers' cancel/reschedule are handled by the primary buttons below.
    } else if (role === "barber") {
      add("checked_in", "Mark checked in");
      add("in_progress", "Start service");
      add("completed", "Mark completed");
      add("no_show", "Mark no-show", true);
    } else if (role === "shop_owner") {
      add("confirmed", "Confirm");
      add("checked_in", "Mark checked in");
      add("in_progress", "Start service");
      add("completed", "Mark completed");
      add("no_show", "Mark no-show", true);
    } else {
      // super_admin / admin → render every transition that isn't a no-op or
      // already represented by a dedicated button.
      for (const status of BOOKING_STATUSES) {
        if (status === currentStatus) continue;
        if (HANDLED_BY_DEDICATED_BUTTONS.includes(status)) continue;
        const destructive = DESTRUCTIVE_TARGETS.includes(status);
        candidates.push({
          status,
          label: `Override · ${rawBookingStatusLabel(status)}`,
          destructive,
        });
      }
    }

    return candidates;
  }, [booking, currentStatus, role, HANDLED_BY_DEDICATED_BUTTONS]);

  const canResend = role !== "customer";
  const canDestructive = canPerformBookingDestructiveOps(user, token);
  const showRefundClient = Boolean(
    booking && canDestructive && canShowRefundClientButton(booking),
  );
  const canRemoveFromHistory = Boolean(
    booking && !canDestructive && canUserRemoveBookingFromHistory(booking),
  );
  const canViewReceipt = true;

  const updateStatus = useCallback(
    async (target: BookingStatus, label: string, destructive: boolean) => {
      if (!booking) return;
      const proceed = async () => {
        setBusy(true);
        try {
          const result = await setBookingStatus(bookingId, target);
          if (result.booking) {
            setBooking((prev) =>
              prev ? { ...prev, ...(result.booking as Partial<BookingDetail>) } : prev,
            );
          }
          Alert.alert("Updated", result.message);
          void load();
        } catch (e) {
          Alert.alert("Update failed", userFacingApiError(e));
        } finally {
          setBusy(false);
        }
      };

      if (destructive) {
        // Customer-facing cancel/reschedule prompts are translated; the
        // staff/admin variants intentionally stay in English (operational).
        const messageMap: Record<string, string> = {
          cancelled:
            role === "customer"
              ? t("booking.details.customerCancelMessage")
              : "Cancel this booking? The customer keeps any prior PayPal capture until a refund is issued in the provider console.",
          no_show:
            "Mark this customer as a no-show? This is recorded in the booking history and can affect their account.",
          rescheduled:
            role === "customer"
              ? t("booking.details.customerRescheduleMessage")
              : "Mark this booking as needing a reschedule? You'll need to confirm a new time afterward.",
        };
        Alert.alert(label, messageMap[target] || "This action will change the booking record.", [
          { text: t("common.keepAsIs"), style: "cancel" },
          { text: label, style: "destructive", onPress: () => void proceed() },
        ]);
      } else {
        Alert.alert(label, `${label}?`, [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("common.confirm"), onPress: () => void proceed() },
        ]);
      }
    },
    [booking, bookingId, load, role],
  );

  const onOpenCancel = useCallback(() => {
    navigation.navigate("CancelBooking", { bookingId });
  }, [navigation, bookingId]);

  const onOpenReschedule = useCallback(() => {
    navigation.navigate("RescheduleBooking", { bookingId });
  }, [navigation, bookingId]);

  const onResend = async () => {
    if (!booking) return;
    setBusy(true);
    try {
      const message = await resendBookingConfirmation(bookingId);
      Alert.alert("Confirmation", message);
    } catch (e) {
      Alert.alert("Confirmation", userFacingApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const onContact = () => {
    if (!booking) return;
    if (role === "customer") {
      const shop = String(booking.shop_name || "the shop").trim();
      Alert.alert(
        t("booking.details.contactShopAlertTitle"),
        t("booking.details.contactShopAlertBody", { shop }),
      );
      return;
    }
    const phone = String(booking.phone || "").trim();
    const email = String(booking.customer_email || "").trim();
    const cleanEmail = displayCustomerEmail(email);
    const usableEmail =
      cleanEmail !== "Guest customer" && cleanEmail !== "No email on file" ? cleanEmail : "";

    if (!phone && !usableEmail) {
      Alert.alert("Contact customer", "No customer contact info is on file for this booking.");
      return;
    }

    const choices: { text: string; onPress?: () => void; style?: "cancel" | "default" }[] = [];
    if (phone) {
      choices.push({
        text: `Call ${phone}`,
        onPress: () => {
          Linking.openURL(`tel:${phone.replace(/[^0-9+]/g, "")}`).catch(() =>
            Alert.alert("Contact customer", phone),
          );
        },
      });
    }
    if (usableEmail) {
      choices.push({
        text: `Email ${usableEmail}`,
        onPress: () => {
          const subject = encodeURIComponent(
            `IFCDC Barbers — appointment ${String(bookingId).slice(0, 8)}`,
          );
          Linking.openURL(`mailto:${usableEmail}?subject=${subject}`).catch(() =>
            Alert.alert("Contact customer", usableEmail),
          );
        },
      });
    }
    choices.push({ text: "Cancel", style: "cancel" });
    Alert.alert("Contact customer", "How would you like to reach them?", choices);
  };

  const onRefundClient = () => {
    if (!booking || !canShowRefundClientButton(booking)) {
      Alert.alert(
        "Refund unavailable",
        "Refund unavailable: no payment transaction found.",
      );
      return;
    }
    Alert.alert(
      "Refund Client",
      "Issue a PayPal refund and cancel this booking? Funds return via PayPal in 3–10 business days.",
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
                setBooking((prev) =>
                  prev ? { ...prev, ...(result.booking as Partial<BookingDetail>) } : prev,
                );
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

  const onRemoveFromHistory = () => {
    if (!booking) return;
    if (!canUserRemoveBookingFromHistory(booking)) {
      Alert.alert("Cannot remove", bookingRemovalBlockedMessage(booking));
      return;
    }
    void (async () => {
      if (!(await confirmDelete())) return;
      setBusy(true);
      try {
        const result = await removeBookingFromHistory(bookingId);
        Alert.alert("Removed", result.message, [
          { text: "OK", onPress: () => navigation.goBack() },
        ]);
      } catch (e) {
        Alert.alert("Remove failed", userFacingApiError(e));
      } finally {
        setBusy(false);
      }
    })();
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
                        { text: "OK", onPress: () => navigation.goBack() },
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

  const onViewReceipt = () => {
    if (!booking) return;
    const lines: string[] = [];
    lines.push(`Booking #${String(booking.id).slice(0, 8)}`);
    lines.push(`Service: ${booking.service || booking.style_title || "—"}`);
    lines.push(`Service price: ${servicePriceFor(booking)}`);
    lines.push(`Platform fee: ${formatMoney(booking.platform_fee)}`);
    lines.push(`Total paid: ${formatMoney(booking.total_paid ?? booking.total_amount)}`);
    lines.push(`Method: ${paymentMethodLabel(booking)}`);
    if (booking.paypal_order_id) lines.push(`PayPal order: ${booking.paypal_order_id}`);
    if (booking.paypal_capture_id) lines.push(`PayPal capture: ${booking.paypal_capture_id}`);
    Alert.alert("Receipt", lines.join("\n"));
  };

  if (loading) {
    return (
      <ProfileScreenLayout title={t("booking.details.title")} subtitle={subtitle}>
        <ScreenLoading />
      </ProfileScreenLayout>
    );
  }

  if (!booking) {
    return (
      <ProfileScreenLayout title={t("booking.details.title")} subtitle={subtitle}>
        <Text style={styles.muted}>{t("booking.details.notAvailable")}</Text>
        <View style={{ height: 12 }} />
        <GlowButton
          label={t("booking.details.goBack")}
          variant="outline"
          onPress={() => navigation.goBack()}
        />
      </ProfileScreenLayout>
    );
  }

  const customerEmail = displayCustomerEmail(booking.customer_email);
  const customerName = displayCustomerName(booking.customer_name, booking.customer_email);
  const appointmentWhen = formatBookingDateTime(booking.date, booking.time, booking.created_at);
  const notesValue =
    String(booking.notes || "").trim() ||
    (booking.style_title && booking.style_title !== booking.service
      ? `Style: ${booking.style_title}`
      : "—");
  const durationLabel =
    booking.service_duration_minutes != null && Number(booking.service_duration_minutes) > 0
      ? `${Number(booking.service_duration_minutes)} min`
      : "—";

  return (
    <ProfileScreenLayout title={t("booking.details.title")} subtitle={subtitle} headerTopPad={12}>
      <ProfileCard style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroCopy}>
            <Text style={styles.service}>
              {booking.service || booking.style_title || t("booking.details.appointment")}
            </Text>
            <Text style={styles.when}>{appointmentWhen}</Text>
          </View>
          <BookingStatusBadge
            paymentStatus={booking.payment_status}
            bookingStatus={booking.booking_status}
          />
        </View>
        <Text style={styles.total}>
          {formatMoney(booking.total_amount ?? booking.total_price)}
        </Text>
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>{t("booking.details.statusTimeline")}</Text>
        <StatusTimeline
          history={history}
          bookingCreatedAt={booking.created_at}
          currentStatus={booking.booking_status || undefined}
        />
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>{t("booking.details.customer")}</Text>
        <MetaRow label={t("booking.details.name")} value={customerName} />
        <MetaRow label={t("booking.details.email")} value={customerEmail} />
        {role !== "customer" ? (
          <MetaRow
            label={t("booking.details.phone")}
            value={booking.phone ? String(booking.phone) : "—"}
          />
        ) : null}
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>{t("booking.details.appointment")}</Text>
        <MetaRow label={t("booking.bookingId")} value={String(booking.id)} />
        <MetaRow label={t("booking.barber")} value={booking.barber_name || "—"} />
        <MetaRow label={t("booking.details.shop")} value={booking.shop_name || "—"} />
        <MetaRow
          label={t("booking.service")}
          value={booking.service || booking.style_title || "—"}
        />
        <MetaRow label={t("booking.duration")} value={durationLabel} />
        <MetaRow label={t("booking.details.scheduled")} value={appointmentWhen} />
        <MetaRow
          label={t("booking.details.bookingStatus")}
          value={rawBookingStatusLabel(booking.booking_status || "confirmed")}
        />
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>{t("booking.details.payment")}</Text>
        <MetaRow
          label={t("booking.details.paymentStatus")}
          value={paymentStatusHeadline(
            booking.payment_status,
            Number((booking as { balance_due?: number | string | null }).balance_due ?? booking.remaining_balance),
            Number(
              (booking as { amount_charged?: number | string | null }).amount_charged ??
                booking.amount_paid ??
                booking.total_paid,
            ),
          )}
        />
        <MetaRow label={t("booking.details.servicePrice")} value={servicePriceFor(booking)} />
        <MetaRow label={t("booking.platformFee")} value={formatMoney(booking.platform_fee)} />
        <MetaRow label={t("booking.details.tip", { defaultValue: "Tip" })} value={formatMoney(booking.tip_amount)} />
        <MetaRow
          label={t("booking.chargedToday")}
          value={formatMoney(
            (booking as { amount_charged?: number }).amount_charged ??
              booking.amount_paid ??
              booking.total_paid,
          )}
        />
        <MetaRow
          label={t("booking.balanceDue")}
          value={formatMoney(
            (booking as { balance_due?: number }).balance_due ?? booking.remaining_balance ?? 0,
          )}
        />
        <MetaRow
          label={t("booking.details.totalPaid")}
          value={formatMoney(booking.total_paid ?? booking.total_amount)}
        />
        <MetaRow label={t("booking.details.method")} value={paymentMethodLabel(booking)} />
        <MetaRow label={t("booking.details.summaryRow")} value={paymentBreakdown(booking)} />
        {role !== "customer" ? (
          <>
            {/* Operational PayPal references — kept in English per directive. */}
            <MetaRow label="PayPal order" value={booking.paypal_order_id || "—"} />
            {booking.paypal_capture_id ? (
              <MetaRow label="PayPal ref" value={booking.paypal_capture_id} />
            ) : null}
          </>
        ) : null}
      </ProfileCard>

      <ProfileCard style={styles.section}>
        <Text style={styles.sectionTitle}>{t("booking.details.notes")}</Text>
        <MetaRow label={t("booking.details.detailsRow")} value={notesValue} />
        <MetaRow label={t("booking.details.created")} value={formatCreatedAt(booking.created_at)} />
        {booking.cancelled_at ? (
          <MetaRow
            label={t("booking.details.cancelledRow")}
            value={`${formatCreatedAt(booking.cancelled_at)}${
              booking.cancelled_by ? ` · ${String(booking.cancelled_by).replace(/_/g, " ")}` : ""
            }`}
          />
        ) : null}
        {booking.cancellation_reason ? (
          <MetaRow
            label={t("booking.details.cancelReason")}
            value={String(booking.cancellation_reason)}
          />
        ) : null}
        {booking.rescheduled_at ? (
          <MetaRow
            label={t("booking.details.lastRescheduled")}
            value={`${formatCreatedAt(booking.rescheduled_at)}${
              booking.rescheduled_by ? ` · ${String(booking.rescheduled_by).replace(/_/g, " ")}` : ""
            }`}
          />
        ) : null}
        {booking.rescheduled_from_date ? (
          <MetaRow
            label={t("booking.details.movedFrom")}
            value={`${String(booking.rescheduled_from_date).slice(0, 10)}${
              booking.rescheduled_from_time
                ? ` at ${String(booking.rescheduled_from_time).slice(0, 5)}`
                : ""
            }`}
          />
        ) : null}
      </ProfileCard>

      {role === "customer" && currentStatus === "completed" && (canReview || hasReview || followupDue) ? (
        <ProfileCard style={styles.section} glow={canReview}>
          <Text style={styles.sectionTitle}>Share your experience</Text>
          {canReview ? (
            <>
              <Text style={styles.reviewPrompt}>
                How was your cut with {booking.barber_name || "your barber"}? Leave a verified review and optional photos.
              </Text>
              <GlowButton label="Leave a review" onPress={onOpenReview} disabled={busy} />
            </>
          ) : null}
          {hasReview && !canReview ? (
            <>
              <Text style={styles.reviewPrompt}>Thanks — you already reviewed this appointment.</Text>
              {canEditReview || canDeleteReview ? (
                <View style={styles.reviewActions}>
                  {canEditReview ? (
                    <GlowButton label="Edit review" variant="outline" onPress={onEditReview} disabled={busy} />
                  ) : null}
                  {canDeleteReview ? (
                    <GlowButton label="Delete review" variant="outline" onPress={onDeleteReview} disabled={busy} />
                  ) : null}
                </View>
              ) : null}
            </>
          ) : null}
          {followupDue ? (
            <>
              <Text style={[styles.reviewPrompt, { marginTop: canReview || hasReview ? 10 : 0 }]}>
                It's been about 30 days — share an updated photo showing how your cut grew out.
              </Text>
              <GlowButton label="Upload 30-day photo" variant="outline" onPress={onOpenFollowup} disabled={busy} />
            </>
          ) : null}
        </ProfileCard>
      ) : null}

      {booking.barber_id ? (
        <ProfileCard style={styles.section}>
          <Text style={styles.sectionTitle}>Barber portfolio</Text>
          <Text style={styles.reviewPrompt}>See photos, reviews, and services before your next visit.</Text>
          <GlowButton label="View portfolio" variant="outline" onPress={onViewBarberPortfolio} disabled={busy} />
        </ProfileCard>
      ) : null}

      <View style={styles.actions}>
        {canViewReceipt ? (
          <GlowButton
            label={t("booking.details.viewReceipt")}
            variant="outline"
            onPress={onViewReceipt}
            disabled={busy}
          />
        ) : null}
        {canResend ? (
          <GlowButton
            label={t("booking.details.resendConfirmation")}
            variant="outline"
            onPress={() => void onResend()}
            disabled={busy}
            loading={busy}
          />
        ) : null}
        <GlowButton
          label={
            role === "customer"
              ? t("booking.details.contactShop")
              : t("booking.details.contactCustomer")
          }
          variant="outline"
          onPress={onContact}
          disabled={busy}
        />

        <ShareButton
          variant="block"
          label={
            String(booking.booking_status || "").toLowerCase() === "completed"
              ? t("booking.shareReceipt")
              : t("booking.shareBooking")
          }
          title={`${booking.service || t("booking.details.appointment")} · ${APP_BRAND_NAME}`}
          message={
            String(booking.booking_status || "").toLowerCase() === "completed"
              ? buildReceiptShareMessage({
                  serviceName: booking.service || booking.style_title || null,
                  barberName: booking.barber_name || null,
                  shopName: booking.shop_name || null,
                  whenLabel: appointmentWhen,
                })
              : buildBookingShareMessage({
                  serviceName: booking.service || booking.style_title || null,
                  barberName: booking.barber_name || null,
                  shopName: booking.shop_name || null,
                  whenLabel: appointmentWhen,
                })
          }
        />

        {canRescheduleHere ? (
          <GlowButton
            label={t("booking.details.rescheduleBtn")}
            onPress={onOpenReschedule}
            disabled={busy}
          />
        ) : null}
        {canCancelHere ? (
          <GlowButton
            label={t("booking.details.cancelAppointment")}
            variant="outline"
            onPress={onOpenCancel}
            disabled={busy}
          />
        ) : null}

        {statusActions.length > 0 ? (
          <View style={styles.statusGroup}>
            {/*
              Operational status panel: header + button labels for staff/admin
              flows are intentionally kept in English per Phase 2 directive
              ("admin/super_admin operational text in English").
            */}
            <Text style={styles.statusGroupHeader}>
              {isOverride ? "Override status" : "Status actions"}
            </Text>
            {statusActions.map((item) => (
              <GlowButton
                key={item.status}
                label={item.label}
                variant={item.destructive ? "outline" : "primary"}
                onPress={() => void updateStatus(item.status, item.label, !!item.destructive)}
                disabled={busy}
              />
            ))}
          </View>
        ) : !canRescheduleHere && !canCancelHere ? (
          <Text style={styles.terminalHint}>
            {isFinalStatus(booking.booking_status)
              ? t("booking.details.reachedFinalState")
              : t("booking.details.noStatusChanges")}
          </Text>
        ) : null}

        {showRefundClient ? (
          <GlowButton
            label="Refund Client"
            variant="danger"
            onPress={onRefundClient}
            disabled={busy}
          />
        ) : null}
        {canRemoveFromHistory ? (
          <GlowButton
            label="Remove from history"
            variant="danger"
            onPress={onRemoveFromHistory}
            disabled={busy}
          />
        ) : null}
        {canDestructive ? (
          <GlowButton
            label="Delete Booking"
            variant="danger"
            onPress={onDeleteBooking}
            disabled={busy}
          />
        ) : null}
      </View>
    </ProfileScreenLayout>
  );
}

const styles = StyleSheet.create({
  muted: { color: theme.colors.textMuted, textAlign: "center", marginTop: 24, fontSize: 15 },
  hero: { gap: 10, paddingVertical: 16 },
  heroTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
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
  actions: { gap: 10, marginTop: 4, marginBottom: 8 },
  statusGroup: { gap: 10, marginTop: 6 },
  statusGroupHeader: {
    color: theme.colors.gold,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  terminalHint: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    paddingVertical: 4,
  },
  reviewPrompt: {
    color: theme.colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
  },
  reviewActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
});

const timelineStyles = StyleSheet.create({
  column: { gap: 4, paddingTop: 4 },
  row: { flexDirection: "row", gap: 12 },
  dotCol: { width: 16, alignItems: "center" },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.25)",
    marginTop: 4,
  },
  dotPaid: { backgroundColor: "#34d399" },
  dotActive: { backgroundColor: "#60a5fa" },
  dotPending: { backgroundColor: theme.colors.gold },
  dotCancelled: { backgroundColor: "#f87171" },
  dotNoshow: { backgroundColor: "#fb923c" },
  dotResched: { backgroundColor: "#a78bfa" },
  line: {
    flex: 1,
    width: 2,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginTop: 4,
  },
  copyCol: { flex: 1, paddingBottom: 14 },
  statusLine: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  metaLine: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17 },
  note: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontStyle: "italic",
    marginTop: 4,
    lineHeight: 17,
  },
});
