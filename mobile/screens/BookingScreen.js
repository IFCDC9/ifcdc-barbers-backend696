import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Platform,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import { calculateFinalBookingTotal } from '../lib/bookingPaymentTotals.js';
import {
  startAppBookingCheckout,
  finalizeAppBookingCheckout,
  fetchAvailableSlots,
  fetchBookingServices,
  pingBookingApi,
  fetchBarbersList,
} from '../services/bookingPayPalApi.js';
import { reportConnectionFailure } from '../services/connectionAlerts';
import { resolveMobilePayPalReturnUrl } from '../utils/paypalReturnUrl';
import { subscribeScheduleUpdated } from '../services/scheduleEvents';
import { useLiveSlotRefresh } from '../hooks/useLiveSlotRefresh';
import AppointmentTimeSlotList from '../components/AppointmentTimeSlotList';
import BookingMonthCalendar from '../components/BookingMonthCalendar';
import ServicePickerCard from '../components/ServicePickerCard';
import ShareButton from '../components/ShareButton';
import { DEFAULT_BOOKING_SERVICES } from '../lib/defaultBookingServices.js';
import {
  APP_BRAND_NAME,
  buildBookingShareMessage,
} from '../utils/shareContent';
import {
  formatAppointmentDateLabel,
  formatMoney,
  paymentMethodDisplayLabel,
  paymentStatusHeadline,
} from '../utils/bookingDisplay';
import { formatCheckoutError } from '../utils/checkoutError';
import DarkGradientBackground from '../components/DarkGradientBackground';
import { palette, radius } from '../constants/theme';
import { IFCDC_FOOTER_CLEARANCE } from '../constants/profileLayout';
import ProviderTypeDropdown from '../components/ProviderTypeDropdown';
import { providerTypeMeta } from '../constants/providerTypes';
import { useAuth } from '../services/authContext';
import { fetchMyLoyalty } from '../services/loyaltyApi';

/** Visual tokens only — booking/payment logic unchanged */
const UI = {
  bg: palette.bg0,
  card: palette.card,
  surface: palette.bg2,
  gold: palette.gold,
  goldSoft: palette.goldHigh,
  text: palette.text,
  muted: palette.textMuted,
  dim: palette.textDim,
  border: palette.borderGold,
  borderStrong: palette.borderGoldStrong,
  glass: palette.surfaceLine,
  success: palette.success,
  warning: palette.warning,
  danger: palette.danger,
  onGold: palette.onGold,
};

const FALLBACK_SERVICE_PRICE = 25;

function estimateRewardDiscount(reward, services, subtotal) {
  if (!reward) return 0;
  const type = String(reward.reward_type || '').toLowerCase();
  const value = Math.max(0, Number(reward.reward_value) || 0);
  let discount = value;
  if (type === 'discount_percent') discount = subtotal * Math.min(value, 100) / 100;
  if (type === 'free_service' || type === 'free_standard_haircut') {
    const eligible = Array.isArray(reward.eligible_services)
      ? reward.eligible_services.map((item) => String(item).toLowerCase())
      : [];
    const matching = services.filter((service) => {
      if (!eligible.length) return true;
      const id = String(service?.id || '').toLowerCase();
      const name = String(service?.name || '').toLowerCase();
      return eligible.some((allowed) => id === allowed || name.includes(allowed) || allowed.includes(name));
    });
    discount = matching.length ? Math.max(...matching.map((service) => Number(service?.price) || 0)) : 0;
    if (!discount && !eligible.length) discount = subtotal;
    if (value > 0) discount = Math.min(discount || value, value);
  }
  return Math.round(Math.max(0, Math.min(subtotal, discount)) * 100) / 100;
}

function parsePayPalReturnToken(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('token');
  } catch {
    return null;
  }
}

function buildDateOptions(count = 7) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const options = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    if (i === 0) options.push('Today');
    else if (i === 1) options.push('Tomorrow');
    else options.push(days[d.getDay()]);
  }
  return options;
}

function BookingScreen() {
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { user } = useAuth();
  /**
   * Translate a date label produced by buildDateOptions() to the user's
   * language for DISPLAY only. The underlying value (English: "Today",
   * "Tomorrow", "Monday"…) is preserved in state and sent to the backend
   * unchanged so the API contract is untouched.
   */
  const dateDisplay = (v) => {
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      const [y, m, d] = String(v).split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    }
    return t(`booking.dates.${String(v).toLowerCase()}`, { defaultValue: v });
  };
  const [step, setStep] = useState(1);
  const [barber, setBarber] = useState(null);
  const [date, setDate] = useState(null);
  const [selectedServices, setSelectedServices] = useState([]);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesUsingFallback, setServicesUsingFallback] = useState(false);
  const [servicesLoadKey, setServicesLoadKey] = useState(0);
  const [time, setTime] = useState(null);
  const [availableSlots, setAvailableSlots] = useState([]);
  const [unavailabilityMessage, setUnavailabilityMessage] = useState('');
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [availableRewards, setAvailableRewards] = useState([]);
  const [selectedRewardId, setSelectedRewardId] = useState(null);
  const [tipAmount, setTipAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [promoCode, setPromoCode] = useState('');
  const [promoMessage, setPromoMessage] = useState('');
  const cartTotalPrice = useMemo(
    () =>
      selectedServices.reduce((sum, s) => sum + (Number(s?.price) || 0), 0),
    [selectedServices],
  );
  const cartTotalDuration = useMemo(
    () =>
      Math.max(
        1,
        selectedServices.reduce((sum, s) => sum + (Number(s?.duration_minutes) || 30), 0),
      ),
    [selectedServices],
  );
  const selectedReward = useMemo(
    () => availableRewards.find((reward) => reward.id === selectedRewardId) || null,
    [availableRewards, selectedRewardId],
  );
  const rewardDiscount = useMemo(
    () => estimateRewardDiscount(selectedReward, selectedServices, cartTotalPrice),
    [selectedReward, selectedServices, cartTotalPrice],
  );
  const pricing = useMemo(
    () =>
      calculateFinalBookingTotal({
        haircutPrice:
          Number.isFinite(cartTotalPrice) && cartTotalPrice > 0 ? cartTotalPrice : FALLBACK_SERVICE_PRICE,
        discountAmount: rewardDiscount,
        tipAmount,
      }),
    [cartTotalPrice, rewardDiscount, tipAmount],
  );

  const [successPayload, setSuccessPayload] = useState(null);

  const [barbers, setBarbers] = useState([]);
  const [barbersLoading, setBarbersLoading] = useState(true);
  const [barbersError, setBarbersError] = useState(null);
  const [providerFilter, setProviderFilter] = useState('');
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0);

  useEffect(() => {
    return subscribeScheduleUpdated(() => setScheduleRefreshKey((k) => k + 1));
  }, []);

  useLiveSlotRefresh(
    useCallback(() => setScheduleRefreshKey((k) => k + 1), []),
    step === 4 && Boolean(barber && date),
  );

  const loadBarbers = useCallback(async () => {
    setBarbersLoading(true);
    setBarbersError(null);
    try {
      const list = await fetchBarbersList(providerFilter || undefined);
      const items = list
        .filter((b) => b && b.active !== false)
        .map((b) => ({
          id: b.id,
          name: String(b.name || '').trim(),
          providerType: b.providerType || b.provider_type || 'barber',
        }))
        .filter((b) => b.name);
      setBarbers(items);
      setBarbersError(items.length ? null : t('booking.noBarbers'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[booking] fetch barbers failed:', msg, e?.url);
      setBarbers([]);
      setBarbersError(t('booking.loadBarbersError'));
      reportConnectionFailure({
        kind: 'network',
        url: e?.url,
        message: msg,
      });
    } finally {
      setBarbersLoading(false);
    }
  }, [t, providerFilter]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await loadBarbers();
      } finally {
        if (!alive) return;
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadBarbers]);

  useEffect(() => {
    if (step !== 5) return;
    let alive = true;
    (async () => {
      try {
        const r = await pingBookingApi();
        if (!alive) return;
        if (r.ok) {
          console.log('[IFCDC] Backend reachable:', r.body);
        } else {
          console.warn('[IFCDC] Backend health check failed:', r.status, r.url, r.body);
        }
      } catch (e) {
        console.warn('[IFCDC] Backend health check error:', e?.message || e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [step]);

  useEffect(() => {
    let active = true;
    if (step !== 5 || !user?.email || !barber?.id) {
      setAvailableRewards([]);
      setSelectedRewardId(null);
      return () => {
        active = false;
      };
    }
    fetchMyLoyalty(barber.id)
      .then((data) => {
        if (!active) return;
        const barberValues = [barber.id, barber.name].map((value) => String(value || '').toLowerCase());
        const serviceValues = selectedServices.flatMap((service) =>
          [service.id, service.name].map((value) => String(value || '').toLowerCase()),
        );
        const eligible = (Array.isArray(data.availableRewards) ? data.availableRewards : []).filter((reward) => {
          const allowedBarbers = (reward.eligible_barbers || []).map((value) => String(value).toLowerCase());
          const allowedServices = (reward.eligible_services || []).map((value) => String(value).toLowerCase());
          return (
            (!allowedBarbers.length || barberValues.some((value) => allowedBarbers.includes(value)))
            && (
              !allowedServices.length
              || serviceValues.some((value) =>
                allowedServices.some((allowed) =>
                  value === allowed || value.includes(allowed) || allowed.includes(value),
                ),
              )
            )
          );
        });
        setAvailableRewards(eligible);
      })
      .catch(() => {
        if (active) setAvailableRewards([]);
      });
    return () => {
      active = false;
    };
  }, [step, user?.email, barber?.id, barber?.name, selectedServices]);

  useEffect(() => {
    let cancelled = false;
    let safetyTimer = null;

    const finishLoading = () => {
      if (!cancelled) setServicesLoading(false);
    };

    const applyServices = (list, result) => {
      setServices(list);
      setServicesUsingFallback(Boolean(result?.usedLocalFallback));
      const resolvedId = result?.barberId ?? barber?.id;
      if (resolvedId != null) {
        setBarber((prev) => {
          if (!prev || String(prev.id) === String(resolvedId)) return prev;
          return { ...prev, id: resolvedId };
        });
      }
      setSelectedServices((prev) => prev.filter((s) => list.some((x) => String(x.id) === String(s.id))));
    };

    const load = async () => {
      if (step !== 3 || !barber?.name) return;

      setServicesLoading(true);
      setServicesUsingFallback(false);

      safetyTimer = setTimeout(() => {
        if (cancelled) return;
        console.warn('[services] safety timeout — showing fallback menu');
        applyServices(DEFAULT_BOOKING_SERVICES, { usedLocalFallback: true });
        finishLoading();
      }, 13000);

      try {
        const result = await fetchBookingServices({
          barberId: barber?.id,
          barberName: barber?.name,
        });
        if (cancelled) return;
        const list = result.services?.length ? result.services : DEFAULT_BOOKING_SERVICES;
        applyServices(list, result);
      } catch (e) {
        console.warn('[services] unexpected load error:', e?.message || e);
        if (!cancelled) {
          applyServices(DEFAULT_BOOKING_SERVICES, { usedLocalFallback: true });
        }
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer);
        finishLoading();
      }
    };

    load();
    return () => {
      cancelled = true;
      if (safetyTimer) clearTimeout(safetyTimer);
    };
  }, [step, barber?.id, barber?.name, servicesLoadKey, scheduleRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (step !== 4 || !barber || !date) return;
      setSlotsLoading(true);
      setSlotsError(null);
      setAvailableSlots([]);
      setUnavailabilityMessage('');
      try {
        const result = await fetchAvailableSlots({
          barberId: barber?.id,
          barberName: barber?.name,
          dateLabel: date,
          durationMinutes: cartTotalDuration,
        });
        if (!cancelled) {
          setAvailableSlots(result.slots || []);
          setUnavailabilityMessage(
            result.unavailability?.message ||
              (result.reasonIfEmpty === 'blocked_date'
                ? 'This provider is unavailable at this time. Please choose another available appointment.'
                : ''),
          );
        }
      } catch (e) {
        console.log('available-slots', e);
        if (!cancelled) {
          setAvailableSlots([]);
          setUnavailabilityMessage('');
          setSlotsError(t('booking.loadTimesError'));
        }
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [step, barber, date, scheduleRefreshKey, cartTotalDuration]);

  const resetFlow = () => {
    setStep(1);
    setBarber(null);
    setDate(null);
    setSelectedServices([]);
    setServices([]);
    setServicesUsingFallback(false);
    setServicesLoadKey(0);
    setTime(null);
    setAvailableSlots([]);
    setSlotsError(null);
    setSuccessPayload(null);
    setPhaseLabel('');
    setSelectedRewardId(null);
    setTipAmount(0);
    setPaymentMethod('card');
    setPromoCode('');
    setPromoMessage('');
  };

  const resolveCustomerEmail = () => {
    const fromUser = String(user?.email || '').trim();
    if (fromUser) return fromUser;
    return String(guestEmail || '').trim();
  };

  const toggleService = (service) => {
    setSelectedServices((prev) => {
      const exists = prev.some((s) => String(s.id) === String(service.id));
      if (exists) return prev.filter((s) => String(s.id) !== String(service.id));
      return [...prev, service];
    });
  };

  const applyPromoCode = () => {
    const normalized = promoCode.trim().toUpperCase();
    if (!normalized) {
      setPromoMessage('Enter a promo code.');
      return;
    }
    const promoReward = availableRewards.find(
      (reward) => String(reward?.metadata?.promoCode || reward?.metadata?.promo_code || '').toUpperCase() === normalized,
    );
    if (!promoReward) {
      setPromoMessage('This promo code is not available for this booking.');
      return;
    }
    setSelectedRewardId(promoReward.id);
    setPromoMessage(`${promoReward.title} applied.`);
  };

  const onConfirmPayAndBook = async () => {
    if (processingPayment || !barber?.name || !date || !time || !selectedServices.length) {
      if (!selectedServices.length) {
        Alert.alert(t('booking.selectServiceTitle'), t('booking.selectServiceBody'));
      }
      return;
    }

    const customerEmail = resolveCustomerEmail();
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      Alert.alert(
        t('booking.emailRequiredTitle', { defaultValue: 'Email required' }),
        t('booking.emailRequiredBody', {
          defaultValue:
            'Enter your email so we can send your IFCDC booking confirmation after payment.',
        }),
      );
      return;
    }

    const serviceIds = selectedServices.map((s) => s.id);
    const serviceName = selectedServices.map((s) => s.name).join(', ');

    let checkoutSucceeded = false;
    setProcessingPayment(true);
    setPhaseLabel(t('booking.phases.processingPayment'));

    try {
      setPhaseLabel(t('booking.phases.checkingSlot'));
      const slotCheck = await fetchAvailableSlots({
        barberId: barber.id,
        barberName: barber.name,
        dateLabel: date,
        durationMinutes: cartTotalDuration,
      });
      const stillOpen = slotCheck.slots?.some((s) => s.available && s.time === time);
      if (!stillOpen) {
        const closedMsg =
          slotCheck.unavailability?.message ||
          (slotCheck.reasonIfEmpty === 'blocked_date' || slotCheck.reasonIfEmpty === 'closed_day'
            ? `${barber?.name || 'This provider'} is unavailable on this date. Please choose another available appointment.`
            : t('booking.slotTakenBody'));
        setUnavailabilityMessage(slotCheck.unavailability?.message || '');
        Alert.alert(t('booking.slotTakenTitle'), closedMsg);
        setStep(4);
        setTime(null);
        setAvailableSlots(slotCheck.slots || []);
        return;
      }

      calculateFinalBookingTotal({
        haircutPrice: Number.isFinite(cartTotalPrice) && cartTotalPrice > 0 ? cartTotalPrice : FALLBACK_SERVICE_PRICE,
        discountAmount: rewardDiscount,
        tipAmount,
      });

      const redirectUri = resolveMobilePayPalReturnUrl();
      console.log('[checkout] redirectUri:', redirectUri);
      console.log('[checkout] serviceIds:', serviceIds, 'barber:', barber?.name, barber?.id);

      setPhaseLabel(t('booking.phases.creatingCheckout'));
      const barberUuid =
        typeof barber?.id === 'string' && barber.id.includes('-') ? barber.id : barber?.uuid;
      const customerName = String(user?.name || user?.displayName || "").trim() || "Mobile customer";
      const started = await startAppBookingCheckout({
        barberName: barber?.name,
        barberId: barber?.id,
        barberUuid: barberUuid || undefined,
        dateLabel: date,
        timeLabel: time,
        serviceIds,
        serviceId: serviceIds[0],
        serviceName,
        redirectUri,
        customerEmail,
        customerName,
        rewardId: selectedRewardId || undefined,
        tipAmount,
        paymentMethod,
      });

      const { orderId, approveUrl, paypalReturnUrl, total, platformFee, haircutPrice, depositAmount: dep } = started;
      if (!orderId || !approveUrl) {
        throw new Error('Server did not return PayPal checkout');
      }

      const authReturnUrl = paypalReturnUrl || redirectUri;
      setPhaseLabel(t('booking.phases.completePayment'));
      console.log('[checkout] opening PayPal approveUrl:', String(approveUrl).slice(0, 120));
      const browser = await WebBrowser.openAuthSessionAsync(approveUrl, authReturnUrl);
      console.log('[checkout] PayPal browser result:', browser?.type, browser?.url?.slice?.(0, 80));

      if (browser.type === 'cancel' || browser.type === 'dismiss') {
        Alert.alert(t('booking.paymentCancelledTitle'), t('booking.paymentCancelledBody'));
        return;
      }

      let paidOrderId = orderId;
      if (browser.type === 'success' && browser.url) {
        const token = parsePayPalReturnToken(browser.url);
        if (token) paidOrderId = token;
      }

      setPhaseLabel(t('booking.phases.verifyingBooking'));
      const finalized = await finalizeAppBookingCheckout(paidOrderId);
      const b = finalized?.booking;
      if (!b?.id) {
        throw new Error('Server did not return a confirmed booking');
      }

      const amountPaid = Number(
        b.amountPaid ??
          b.amount_paid ??
          b.amountCharged ??
          b.amount_charged ??
          finalized?.booking?.amountPaid ??
          0,
      );
      const balanceDue = Number(b.balanceDue ?? b.balance_due ?? b.remainingBalance ?? b.remaining_balance ?? 0);
      const platformFeePaid = Number(b.platformFee ?? b.platform_fee ?? platformFee);
      const servicePricePaid = Number(
        b.servicePrice ?? b.serviceAmountPaid ?? b.haircutPrice ?? b.service_price ?? cartTotalPrice,
      );
      const tipPaid = Number(b.tipAmount ?? b.tip_amount ?? 0);
      const paymentStatus = String(b.paymentStatus ?? b.payment_status ?? '');
      const paymentMethod = String(b.paymentMethod ?? b.payment_method ?? 'paypal');
      const captureId =
        finalized?.captureId ?? b.captureId ?? b.transactionId ?? b.paypal_capture_id ?? null;
      const paymentCaptured = finalized?.paymentCaptured === true || Boolean(captureId);
      const isPaidInFull =
        b.isPaidInFull === true ||
        finalized?.bookingConfirmed === true ||
        paymentStatus === 'paid_in_full' ||
        paymentStatus === 'paid_full' ||
        paymentStatus === 'paid' ||
        paymentCaptured;

      if (!paymentCaptured && (!captureId || amountPaid <= 0)) {
        throw new Error('Payment failed — booking not confirmed.');
      }

      setSuccessPayload({
        bookingId: b.id,
        barber: b.barberName || barber?.name,
        service: b.service || selectedServices.map((s) => s.name).join(', '),
        date: String(b.date ?? date),
        time: String(b.time ?? time),
        balanceDue,
        remainingBalance: balanceDue,
        total: Number(b.total ?? b.totalDue ?? total),
        platformFee: platformFeePaid,
        servicePrice: servicePricePaid,
        tipAmount: tipPaid,
        amountPaid,
        chargedToday: amountPaid,
        paymentStatus,
        paymentMethod,
        captureId,
        isPaidInFull,
        isDepositPaid: false,
        paymentStatusLabel: b.paymentStatusLabel ?? 'PAID IN FULL',
      });
      if (finalized?.needsReview) {
        Alert.alert(
          t('booking.paymentReceivedTitle', { defaultValue: 'Payment received' }),
          finalized?.message ||
            t('booking.paymentReceivedBody', {
              defaultValue:
                'PayPal captured your payment. Your booking is being confirmed — watch for your IFCDC email.',
            }),
        );
      } else if (finalized?.emailSent === false) {
        Alert.alert(
          t('booking.emailNotSentTitle', { defaultValue: 'Booking confirmed' }),
          finalized?.emailError
            ? String(finalized.emailError)
            : t('booking.emailNotSentBody', {
                defaultValue:
                  'Payment succeeded but the confirmation email could not be sent. Contact IFCDC with your booking ID.',
              }),
        );
      }

      setPhaseLabel(t('booking.phases.confirmed'));
      checkoutSucceeded = true;
      setStep(6);
    } catch (err) {
      console.error('CHECKOUT INIT FAILED:', err);
      reportConnectionFailure({
        kind: err?.status >= 500 ? 'http' : 'network',
        url: err?.url,
        status: err?.status,
        message: err?.message,
      });
      const paymentCaptured =
        err?.paymentCaptured === true || err?.details?.paymentCaptured === true;
      const paymentFailed =
        !paymentCaptured &&
        (err?.code === 'payment_not_captured' ||
          err?.code === 'payment_balance_mismatch' ||
          /payment failed|not confirmed|not captured/i.test(String(err?.message || '')));
      const msg = paymentCaptured
        ? err?.message ||
          t('booking.paymentCapturedPending', {
            defaultValue:
              'PayPal received your payment. Your booking is being confirmed — check your email or contact IFCDC support.',
          })
        : paymentFailed
        ? t('booking.paymentFailedNotConfirmed')
        : formatCheckoutError(err);
      Alert.alert('Checkout Error', msg);
    } finally {
      setProcessingPayment(false);
      if (!checkoutSucceeded) {
        setPhaseLabel('');
      }
    }
  };

  const bottomPad = Platform.OS === 'ios' ? 28 : 20;

  if (step === 6 && successPayload) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: UI.bg }}
        edges={['top', 'left', 'right', 'bottom']}
      >
        <DarkGradientBackground />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            padding: 20,
            paddingBottom: bottomPad + 24,
          }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={{ color: UI.gold, fontSize: 26, fontWeight: '700', marginBottom: 8 }}>
            {t('booking.confirmedTitle')}
          </Text>
          <Text style={{ color: UI.muted, marginBottom: 20 }}>{phaseLabel}</Text>

          <View
            style={{
              height: 120,
              backgroundColor: UI.card,
              borderRadius: radius.lg,
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 24,
              borderWidth: 1,
              borderColor: UI.border,
            }}
          >
            <Text style={{ color: UI.gold, fontSize: 16 }}>✓</Text>
            <Text style={{ color: UI.dim, marginTop: 8, fontSize: 13 }}>
              {t('booking.confirmedTitle')}
            </Text>
          </View>

          <View style={{ backgroundColor: UI.card, borderRadius: radius.lg, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: UI.border }}>
            <Text style={{ color: UI.text, marginBottom: 6 }}>
              <Text style={{ color: UI.muted }}>{t('booking.service')} </Text>
              {successPayload.service || '—'}
            </Text>
            <Text style={{ color: '#fff', marginBottom: 6 }}>
              <Text style={{ color: '#888' }}>{t('booking.barber')} </Text>
              {successPayload.barber}
            </Text>
            <Text style={{ color: '#fff', marginBottom: 6 }}>
              <Text style={{ color: '#888' }}>{t('booking.when')} </Text>
              {formatAppointmentDateLabel(successPayload.date, successPayload.time)}
            </Text>
            <Text
              style={{
                color: successPayload.paymentStatusLabel === 'PAID IN FULL' ? '#6ee7b7' : '#fbbf24',
                fontWeight: '800',
                fontSize: 16,
                marginBottom: 12,
                letterSpacing: 0.5,
              }}
            >
              {t('booking.paymentStatus')}: {successPayload.paymentStatusLabel}
            </Text>
            <Text style={{ color: '#fff', marginBottom: 6 }}>
              <Text style={{ color: '#888' }}>{t('booking.details.servicePrice')} </Text>
              {formatMoney(successPayload.servicePrice)}
            </Text>
            <Text style={{ color: '#fff', marginBottom: 6 }}>
              <Text style={{ color: '#888' }}>{t('booking.platformFee')} </Text>
              {formatMoney(successPayload.platformFee)}
            </Text>
            {Number(successPayload.tipAmount) > 0 ? (
              <Text style={{ color: '#fff', marginBottom: 6 }}>
                <Text style={{ color: '#888' }}>{t('booking.details.tip', { defaultValue: 'Tip' })} </Text>
                {formatMoney(successPayload.tipAmount)}
              </Text>
            ) : null}
            <Text style={{ color: '#fff', marginBottom: 6 }}>
              <Text style={{ color: '#888' }}>{t('booking.chargedToday', { defaultValue: 'Charged today' })} </Text>
              {formatMoney(successPayload.chargedToday ?? successPayload.amountPaid)}
            </Text>
            <Text style={{ color: '#fff', marginBottom: 6 }}>
              <Text style={{ color: '#888' }}>{t('booking.paymentMethod')} </Text>
              {paymentMethodDisplayLabel(successPayload.paymentMethod)}
            </Text>
            {successPayload.captureId ? (
              <Text style={{ color: '#aaa', marginBottom: 6, fontSize: 12 }} selectable>
                <Text style={{ color: '#888' }}>{t('booking.transactionId')} </Text>
                {successPayload.captureId}
              </Text>
            ) : null}
            <Text style={{ color: '#FFD700', marginTop: 10, fontSize: 18 }}>
              {t('booking.bookingId')}{' '}
              <Text style={{ color: '#fff' }}>{successPayload.bookingId || '—'}</Text>
            </Text>
          </View>

          <View style={{ alignItems: 'center', marginBottom: 16 }}>
            <ShareButton
              variant="block"
              label={t('booking.shareBooking')}
              title={`${t('booking.confirmedTitle')} · ${APP_BRAND_NAME}`}
              message={buildBookingShareMessage({
                serviceName: successPayload.service,
                barberName: successPayload.barber,
                whenLabel:
                  successPayload.date && successPayload.time
                    ? `${dateDisplay(successPayload.date)} · ${successPayload.time}`
                    : null,
              })}
            />
          </View>

          <TouchableOpacity
            onPress={() => {
              resetFlow();
              navigation.navigate('Home');
            }}
            style={{
              padding: 16,
              backgroundColor: '#FFD700',
              borderRadius: 12,
            }}
          >
            <Text style={{ color: '#000', textAlign: 'center', fontWeight: '700' }}>
              {t('common.done')}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: UI.bg }} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingBottom: bottomPad + IFCDC_FOOTER_CLEARANCE + 24,
          paddingRight: 16,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={{ color: '#FFD700', fontSize: 22, marginBottom: 20 }}>
          {t('booking.screenTitle')}
        </Text>

        {step === 1 && (
          <>
            <Text style={{ color: '#fff', marginBottom: 10 }}>{t('booking.selectBarber')}</Text>
            <ProviderTypeDropdown
              label="Filter by provider type"
              includeAll
              registrationMode={false}
              value={providerFilter}
              disabled={barbersLoading}
              onChange={(value) => {
                setProviderFilter(value);
                setBarber(null);
              }}
            />
            <View style={{ height: 10 }} />
            {barbersLoading ? (
              <View style={{ alignItems: "center", marginVertical: 16, gap: 8 }}>
                <ActivityIndicator color="#FFD700" />
                <Text style={{ color: "rgba(255,255,255,0.55)", fontSize: 14 }}>
                  {t('common.loading')}
                </Text>
              </View>
            ) : null}
            {barbersError ? (
              <View style={styles.barbersErrorBox}>
                <Text style={styles.barbersErrorText}>{barbersError}</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('common.retry') || 'Try again'}
                  onPress={() => {
                    console.log('[booking] retry barbers tapped');
                    loadBarbers();
                  }}
                  style={styles.barbersRetryBtn}
                  disabled={barbersLoading}
                >
                  {barbersLoading ? (
                    <ActivityIndicator color="#0b0b0b" />
                  ) : (
                    <Text style={styles.barbersRetryLabel}>
                      {t('common.retry') || 'Try again'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}
            {barbers.map((b) => (
              <View key={String(b.id || b.name)} style={styles.barberRow}>
                <TouchableOpacity
                  onPress={() => {
                    setBarber(b);
                    setStep(2);
                  }}
                  style={[styles.rowBtn, { flex: 1, marginBottom: 0 }]}
                >
                  <Text style={{ color: '#fff' }}>{b.name}</Text>
                  {b.providerType ? (
                    <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 }}>
                      {providerTypeMeta(b.providerType)?.label || 'Barber'}
                    </Text>
                  ) : null}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    navigation.navigate('BarberPortfolio', {
                      slugOrId: String(b.id || b.name),
                      barberName: b.name,
                    })
                  }
                  style={styles.portfolioLink}
                  accessibilityLabel={`View ${b.name} portfolio`}
                >
                  <Text style={styles.portfolioLinkText}>Portfolio</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        {step === 2 && (
          <>
            <Text style={{ color: '#fff', marginBottom: 10 }}>{t('booking.selectDate')}</Text>
            <BookingMonthCalendar
              barberId={barber?.id}
              barberName={barber?.name}
              value={date}
              durationMinutes={30}
              onSelectDate={(ymd) => {
                setDate(ymd);
                setSelectedServices([]);
                setTime(null);
                setStep(3);
              }}
            />
            <TouchableOpacity onPress={() => setStep(1)} style={[styles.rowBtn, { marginTop: 8 }]}>
              <Text style={{ color: UI.gold }}>{t('common.back', { defaultValue: 'Back' })}</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 3 && (
          <>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>{t('booking.barber')}</Text>
              <Text style={styles.summaryValue}>{barber?.name}</Text>
              <Text style={[styles.summaryLabel, { marginTop: 12 }]}>{t('booking.date')}</Text>
              <Text style={styles.summaryValue}>{dateDisplay(date)}</Text>
            </View>

            <Text style={styles.sectionTitle}>
              {t('booking.chooseService')} · {t('booking.multiServiceHint', { defaultValue: 'Select one or more' })}
            </Text>

            {servicesLoading ? (
              <View style={{ alignItems: 'center', marginVertical: 24, gap: 8 }}>
                <ActivityIndicator color="#FFD700" />
                <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14 }}>
                  {t('booking.loadingServices')}
                </Text>
              </View>
            ) : (
              services.map((service) => (
                <ServicePickerCard
                  key={String(service.id)}
                  service={service}
                  selected={selectedServices.some((s) => String(s.id) === String(service.id))}
                  onPress={() => toggleService(service)}
                />
              ))
            )}

            {selectedServices.length > 0 ? (
              <View style={[styles.summaryCard, { marginTop: 16 }]}>
                <Text style={styles.summaryLabel}>
                  {t('booking.cartTitle', { defaultValue: 'Your services' })}
                </Text>
                {selectedServices.map((s) => (
                  <Text key={String(s.id)} style={styles.summaryValue}>
                    {s.name} · ${Number(s.price || 0).toFixed(2)} · {s.duration_minutes || 30} min
                  </Text>
                ))}
                <Text style={[styles.summaryValue, { color: '#FFD700', marginTop: 8 }]}>
                  {t('booking.cartTotal', { defaultValue: 'Total' })}: ${cartTotalPrice.toFixed(2)} ·{' '}
                  {cartTotalDuration} min
                </Text>
              </View>
            ) : null}

            {!servicesLoading && servicesUsingFallback ? (
              <TouchableOpacity
                onPress={() => setServicesLoadKey((k) => k + 1)}
                style={styles.retryLink}
              >
                <Text style={styles.retryLinkText}>{t('booking.retryServices')}</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              disabled={!selectedServices.length || servicesLoading}
              onPress={() => {
                if (selectedServices.length) {
                  setTime(null);
                  setStep(4);
                }
              }}
              style={[
                styles.continueBtn,
                (!selectedServices.length || servicesLoading) && styles.continueBtnDisabled,
              ]}
            >
              <Text style={styles.continueBtnText}>{t('common.continue')}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setStep(2)} style={styles.backLink}>
              <Text style={styles.backLinkText}>{t('booking.changeDate')}</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 4 && (
          <>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>{t('booking.barber')}</Text>
              <Text style={styles.summaryValue}>{barber?.name}</Text>
              <Text style={[styles.summaryLabel, { marginTop: 12 }]}>{t('booking.date')}</Text>
              <Text style={styles.summaryValue}>{dateDisplay(date)}</Text>
              <Text style={[styles.summaryLabel, { marginTop: 12 }]}>{t('booking.service')}</Text>
              <Text style={styles.summaryValue}>
                {selectedServices.map((s) => s.name).join(', ') || '—'}
              </Text>
              <Text style={[styles.summaryLabel, { marginTop: 12 }]}>
                {t('booking.duration', { defaultValue: 'Duration' })}
              </Text>
              <Text style={styles.summaryValue}>{cartTotalDuration} min</Text>
            </View>

            {slotsLoading ? (
              <View style={{ alignItems: "center", marginVertical: 24, gap: 8 }}>
                <ActivityIndicator color="#FFD700" />
                <Text style={{ color: "rgba(255,255,255,0.55)", fontSize: 14 }}>
                  {t('common.loading')}
                </Text>
              </View>
            ) : null}

            {slotsError ? (
              <Text style={styles.errorText}>{slotsError}</Text>
            ) : null}

            {!slotsLoading && !slotsError && !availableSlots.length ? (
              <Text style={[styles.emptyText, unavailabilityMessage && styles.unavailabilityText]}>
                {unavailabilityMessage || t('booking.noTimes')}
              </Text>
            ) : null}

            {!slotsLoading && availableSlots.length ? (
              <AppointmentTimeSlotList
                slots={availableSlots}
                value={time}
                disabled={slotsLoading}
                onSelect={(slotTime) => setTime(slotTime)}
              />
            ) : null}

            <TouchableOpacity
              disabled={!time || slotsLoading}
              onPress={() => {
                if (time) setStep(5);
              }}
              style={[
                styles.continueBtn,
                (!time || slotsLoading) && styles.continueBtnDisabled,
              ]}
            >
              <Text style={styles.continueBtnText}>{t('common.continue')}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setStep(3)} style={styles.backLink}>
              <Text style={styles.backLinkText}>{t('booking.changeService')}</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 5 && (
          <View>
            <View style={styles.checkoutHeader}>
              <View style={styles.checkoutLock}>
                <Text style={{ fontSize: 20 }}>🔒</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkoutTitle}>Secure Checkout</Text>
                <Text style={styles.checkoutSubtitle}>Choose your preferred payment method.</Text>
              </View>
            </View>

            {user?.email && availableRewards.length ? (
              <View style={styles.checkoutSection}>
                <Text style={styles.checkoutSectionTitle}>Available rewards</Text>
                <TouchableOpacity
                  onPress={() => {
                    setSelectedRewardId(null);
                    setPromoMessage('');
                  }}
                  style={[
                    styles.rewardOption,
                    !selectedRewardId && styles.rewardOptionSelected,
                  ]}
                >
                  <Text style={styles.rewardOptionTitle}>No reward</Text>
                </TouchableOpacity>
                {availableRewards.map((reward) => (
                  <TouchableOpacity
                    key={reward.id}
                    onPress={() => {
                      setSelectedRewardId(reward.id);
                      setPromoMessage('');
                    }}
                    style={[
                      styles.rewardOption,
                      selectedRewardId === reward.id && styles.rewardOptionSelected,
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rewardOptionTitle}>Redeem {reward.title}</Text>
                      <Text style={styles.rewardOptionMeta}>
                        {reward.points_cost} points
                        {Number(reward.reward_value) > 0 ? ` · $${Number(reward.reward_value).toFixed(2)} value` : ''}
                      </Text>
                    </View>
                    <Text style={{ color: UI.gold }}>
                      {selectedRewardId === reward.id ? '✓' : '○'}
                    </Text>
                  </TouchableOpacity>
                ))}
                <Text style={{ color: UI.dim, fontSize: 11, marginTop: 5 }}>
                  Points are reserved now and redeemed only after the paid appointment is completed.
                </Text>
              </View>
            ) : null}

            <View style={styles.checkoutSection}>
              <Text style={styles.checkoutSectionTitle}>Apply promo code</Text>
              <View style={styles.promoRow}>
                <TextInput
                  value={promoCode}
                  onChangeText={(value) => {
                    setPromoCode(value);
                    setPromoMessage('');
                  }}
                  placeholder="Promo code"
                  placeholderTextColor={UI.dim}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.promoInput}
                />
                <TouchableOpacity onPress={applyPromoCode} style={styles.promoButton}>
                  <Text style={styles.promoButtonText}>Apply</Text>
                </TouchableOpacity>
              </View>
              {promoMessage ? <Text style={styles.checkoutHint}>{promoMessage}</Text> : null}
            </View>

            <View style={styles.checkoutSection}>
              <Text style={styles.checkoutSectionTitle}>Add a tip</Text>
              <View style={styles.tipRow}>
                {[0, 15, 20, 25].map((percent) => {
                  const amount = Math.round(cartTotalPrice * percent) / 100;
                  const selected = Math.abs(tipAmount - amount) < 0.01;
                  return (
                    <TouchableOpacity
                      key={percent}
                      onPress={() => setTipAmount(amount)}
                      style={[styles.tipButton, selected && styles.tipButtonSelected]}
                    >
                      <Text style={[styles.tipButtonText, selected && styles.tipButtonTextSelected]}>
                        {percent ? `${percent}%` : 'No tip'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.customTipRow}>
                <Text style={styles.checkoutHint}>Custom tip</Text>
                <TextInput
                  value={String(tipAmount)}
                  onChangeText={(value) => setTipAmount(Math.max(0, Math.min(500, Number(value) || 0)))}
                  keyboardType="decimal-pad"
                  style={styles.customTipInput}
                />
              </View>
            </View>

            <View style={styles.checkoutSection}>
              <Text style={styles.checkoutSectionTitle}>Booking summary</Text>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>Service</Text>
                <Text style={styles.summaryLineValue}>{selectedServices.map((s) => s.name).join(', ') || '—'}</Text>
              </View>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>Barber</Text>
                <Text style={styles.summaryLineValue}>{barber?.name}</Text>
              </View>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>Date</Text>
                <Text style={styles.summaryLineValue}>{dateDisplay(date)}</Text>
              </View>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>Time</Text>
                <Text style={styles.summaryLineValue}>{time}</Text>
              </View>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>Tip</Text>
                <Text style={styles.summaryLineValue}>${pricing.tipAmount.toFixed(2)}</Text>
              </View>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>Discount</Text>
                <Text style={styles.summaryLineValue}>−${pricing.discountAmount.toFixed(2)}</Text>
              </View>
              <View style={styles.summaryLine}>
                <Text style={styles.summaryKey}>{t('booking.platformFee')}</Text>
                <Text style={styles.summaryLineValue}>${pricing.platformFee.toFixed(2)}</Text>
              </View>
              <View style={[styles.summaryLine, styles.totalLine]}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalValue}>${pricing.total.toFixed(2)}</Text>
              </View>
            </View>

            {!user?.email ? (
              <View style={{ marginTop: 16 }}>
                <Text style={{ color: '#FFD700', marginBottom: 8 }}>
                  {t('booking.emailForConfirmation', {
                    defaultValue: 'Email for confirmation',
                  })}
                </Text>
                <TextInput
                  value={guestEmail}
                  onChangeText={setGuestEmail}
                  placeholder={t('booking.emailPlaceholder', { defaultValue: 'you@example.com' })}
                  placeholderTextColor="#666"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    backgroundColor: '#222',
                    color: '#fff',
                    padding: 12,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: '#444',
                  }}
                />
              </View>
            ) : (
              <Text style={{ color: '#888', fontSize: 12, marginTop: 12 }}>
                {t('booking.confirmationSentTo', {
                  defaultValue: 'Confirmation will be sent to {{email}}',
                  email: user.email,
                })}
              </Text>
            )}

            <View style={styles.paymentMethods}>
              <TouchableOpacity
                onPress={() => setPaymentMethod('card')}
                style={[
                  styles.paymentMethod,
                  styles.cardPaymentMethod,
                  paymentMethod === 'card' && styles.paymentMethodSelected,
                ]}
              >
                <Text style={styles.paymentMethodIcon}>💳</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.paymentMethodTitle}>Pay with Debit or Credit Card</Text>
                  <Text style={styles.paymentMethodDetail}>
                    Visa, Mastercard, American Express, Discover, and other supported cards.
                  </Text>
                </View>
                <Text style={styles.paymentMethodRadio}>{paymentMethod === 'card' ? '●' : '○'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setPaymentMethod('paypal')}
                style={[styles.paymentMethod, paymentMethod === 'paypal' && styles.paymentMethodSelected]}
              >
                <Text style={styles.paymentMethodIcon}>🅿️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.paymentMethodTitle}>Pay with PayPal</Text>
                  <Text style={styles.paymentMethodDetail}>Sign in with your PayPal account if you prefer.</Text>
                </View>
                <Text style={styles.paymentMethodRadio}>{paymentMethod === 'paypal' ? '●' : '○'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.noAccountNote}>
              <Text style={styles.noAccountText}>
                No PayPal account required. Pay securely with your debit or credit card.
              </Text>
            </View>

            {phaseLabel ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 }}>
                <ActivityIndicator color="#FFD700" style={{ marginRight: 10 }} />
                <Text style={{ color: '#FFD700', flex: 1 }}>{phaseLabel}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              disabled={processingPayment}
              style={[styles.checkoutButton, processingPayment && { opacity: 0.5 }]}
              onPress={onConfirmPayAndBook}
            >
              <Text style={styles.checkoutButtonText}>
                {processingPayment
                  ? t('common.processing')
                  : paymentMethod === 'card'
                    ? `Continue with Card · $${pricing.total.toFixed(2)}`
                    : `Continue with PayPal · $${pricing.total.toFixed(2)}`}
              </Text>
            </TouchableOpacity>
            <Text style={styles.poweredBy}>IFCDC Barbers checkout · Securely powered by PayPal</Text>

            <TouchableOpacity
              onPress={() => setStep(4)}
              style={{ marginTop: 14, padding: 12 }}
            >
              <Text style={{ color: '#888', textAlign: 'center' }}>{t('booking.changeTime')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  checkoutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  checkoutLock: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,200,66,0.13)',
  },
  checkoutTitle: {
    color: UI.gold,
    fontSize: 24,
    fontWeight: '900',
  },
  checkoutSubtitle: {
    color: UI.muted,
    fontSize: 14,
    marginTop: 3,
  },
  checkoutSection: {
    marginBottom: 14,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(245,200,66,0.2)',
    backgroundColor: 'rgba(0,0,0,0.26)',
  },
  checkoutSectionTitle: {
    color: UI.gold,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 10,
  },
  checkoutHint: {
    color: UI.muted,
    fontSize: 11,
    marginTop: 6,
  },
  promoRow: {
    flexDirection: 'row',
    gap: 8,
  },
  promoInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: radius.sm,
    color: UI.text,
    backgroundColor: UI.surface,
  },
  promoButton: {
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: UI.gold,
    borderRadius: radius.sm,
  },
  promoButtonText: {
    color: UI.gold,
    fontWeight: '800',
  },
  tipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  tipButton: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: UI.glass,
    borderRadius: radius.sm,
  },
  tipButtonSelected: {
    borderColor: UI.gold,
    backgroundColor: UI.goldSoft,
  },
  tipButtonText: {
    color: UI.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  tipButtonTextSelected: {
    color: UI.gold,
  },
  customTipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  customTipInput: {
    width: 90,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: radius.sm,
    color: UI.text,
    backgroundColor: UI.surface,
    textAlign: 'right',
  },
  summaryLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 14,
    paddingVertical: 5,
  },
  summaryKey: {
    color: UI.muted,
    fontSize: 13,
  },
  summaryLineValue: {
    flex: 1,
    color: UI.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'right',
  },
  totalLine: {
    marginTop: 7,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: UI.border,
  },
  totalLabel: {
    color: UI.gold,
    fontSize: 17,
    fontWeight: '900',
  },
  totalValue: {
    color: UI.gold,
    fontSize: 18,
    fontWeight: '900',
  },
  paymentMethods: {
    gap: 10,
    marginTop: 18,
  },
  paymentMethod: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 15,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: UI.glass,
    backgroundColor: UI.card,
  },
  cardPaymentMethod: {
    paddingVertical: 18,
    borderColor: 'rgba(245,200,66,0.5)',
    backgroundColor: 'rgba(245,200,66,0.08)',
  },
  paymentMethodSelected: {
    borderColor: UI.gold,
  },
  paymentMethodIcon: {
    fontSize: 21,
  },
  paymentMethodTitle: {
    color: UI.text,
    fontSize: 14,
    fontWeight: '900',
  },
  paymentMethodDetail: {
    color: UI.muted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  paymentMethodRadio: {
    color: UI.gold,
    fontSize: 18,
  },
  noAccountNote: {
    marginTop: 12,
    padding: 12,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(83,193,126,0.1)',
  },
  noAccountText: {
    color: '#9ee5ba',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  checkoutButton: {
    marginTop: 18,
    padding: 16,
    backgroundColor: UI.gold,
    borderRadius: radius.md,
  },
  checkoutButtonText: {
    color: UI.onGold,
    textAlign: 'center',
    fontWeight: '900',
    fontSize: 15,
  },
  poweredBy: {
    color: UI.dim,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 8,
  },
  rowBtn: {
    padding: 15,
    marginBottom: 10,
    backgroundColor: UI.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: UI.border,
  },
  barberRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    marginBottom: 10,
  },
  portfolioLink: {
    paddingHorizontal: 14,
    justifyContent: 'center',
    backgroundColor: UI.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: UI.border,
  },
  portfolioLinkText: {
    color: UI.gold,
    fontSize: 13,
    fontWeight: '700',
  },
  barbersErrorBox: {
    marginBottom: 14,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: UI.borderStrong,
    backgroundColor: UI.glass,
  },
  barbersErrorText: {
    color: UI.danger,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  barbersRetryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: UI.gold,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barbersRetryLabel: {
    color: UI.onGold,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  summaryCard: {
    backgroundColor: UI.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: UI.border,
    padding: 16,
    marginBottom: 20,
  },
  summaryLabel: {
    color: UI.muted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  summaryValue: {
    color: UI.text,
    fontSize: 17,
    fontWeight: '700',
    marginTop: 4,
  },
  sectionTitle: {
    color: UI.gold,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  rewardOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    marginBottom: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: UI.glass,
    backgroundColor: UI.card,
  },
  rewardOptionSelected: {
    borderColor: UI.gold,
    backgroundColor: UI.goldSoft,
  },
  rewardOptionTitle: {
    color: UI.text,
    fontSize: 13,
    fontWeight: '800',
  },
  rewardOptionMeta: {
    color: UI.muted,
    fontSize: 11,
    marginTop: 2,
  },
  hintText: {
    color: UI.muted,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  emptyText: {
    color: UI.dim,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  unavailabilityText: {
    color: UI.text,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(245,200,66,0.35)',
    backgroundColor: 'rgba(245,200,66,0.08)',
  },
  errorText: {
    color: UI.danger,
    marginBottom: 12,
    fontSize: 14,
  },
  continueBtn: {
    marginTop: 24,
    padding: 15,
    backgroundColor: UI.gold,
    borderRadius: radius.md,
  },
  continueBtnDisabled: {
    opacity: 0.45,
  },
  continueBtnText: {
    color: UI.onGold,
    textAlign: 'center',
    fontWeight: '700',
    fontSize: 16,
  },
  backLink: {
    marginTop: 14,
    padding: 12,
    alignItems: 'center',
  },
  backLinkText: {
    color: UI.muted,
    fontSize: 14,
  },
  retryLink: {
    marginTop: 8,
    marginBottom: 4,
    padding: 10,
    alignItems: 'center',
  },
  retryLinkText: {
    color: '#FFD700',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default BookingScreen;
