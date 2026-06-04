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
import * as Linking from 'expo-linking';
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
import { subscribeScheduleUpdated } from '../services/scheduleEvents';
import AppointmentTimeDropdown from '../components/AppointmentTimeDropdown';
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
import { useAuth } from '../services/authContext';

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
  const dateDisplay = (v) =>
    t(`booking.dates.${String(v || '').toLowerCase()}`, { defaultValue: v });
  const [step, setStep] = useState(1);
  const [barber, setBarber] = useState(null);
  const [date, setDate] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesUsingFallback, setServicesUsingFallback] = useState(false);
  const [servicesLoadKey, setServicesLoadKey] = useState(0);
  const [time, setTime] = useState(null);
  const [availableSlots, setAvailableSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const servicePrice = Number(selectedService?.price);
  const pricing = useMemo(
    () =>
      calculateFinalBookingTotal({
        haircutPrice: Number.isFinite(servicePrice) && servicePrice > 0 ? servicePrice : FALLBACK_SERVICE_PRICE,
      }),
    [servicePrice],
  );

  const [successPayload, setSuccessPayload] = useState(null);

  const [barbers, setBarbers] = useState([]);
  const [barbersLoading, setBarbersLoading] = useState(true);
  const [barbersError, setBarbersError] = useState(null);
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0);
  const dates = useMemo(() => buildDateOptions(7), []);

  useEffect(() => {
    return subscribeScheduleUpdated(() => setScheduleRefreshKey((k) => k + 1));
  }, []);

  const loadBarbers = useCallback(async () => {
    setBarbersLoading(true);
    setBarbersError(null);
    try {
      const list = await fetchBarbersList();
      const items = list
        .filter((b) => b && b.active !== false)
        .map((b) => ({ id: b.id, name: String(b.name || '').trim() }))
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
  }, [t]);

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
      setSelectedService((prev) => {
        if (prev && !list.some((s) => String(s.id) === String(prev.id))) return null;
        return prev;
      });
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
      }, 5500);

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
      try {
        const result = await fetchAvailableSlots({
          barberId: barber?.id,
          barberName: barber?.name,
          dateLabel: date,
        });
        if (!cancelled) setAvailableSlots(result.slots || []);
      } catch (e) {
        console.log('available-slots', e);
        if (!cancelled) {
          setAvailableSlots([]);
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
  }, [step, barber, date, scheduleRefreshKey]);

  const resetFlow = () => {
    setStep(1);
    setBarber(null);
    setDate(null);
    setSelectedService(null);
    setServices([]);
    setServicesUsingFallback(false);
    setServicesLoadKey(0);
    setTime(null);
    setAvailableSlots([]);
    setSlotsError(null);
    setSuccessPayload(null);
    setPhaseLabel('');
  };

  const resolveCustomerEmail = () => {
    const fromUser = String(user?.email || '').trim();
    if (fromUser) return fromUser;
    return String(guestEmail || '').trim();
  };

  const onConfirmPayAndBook = async () => {
    if (processingPayment || !barber?.name || !date || !time || !selectedService?.id) {
      if (!selectedService?.id) {
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

    const serviceId = selectedService.id;
    const serviceName = selectedService.name;

    let checkoutSucceeded = false;
    setProcessingPayment(true);
    setPhaseLabel(t('booking.phases.processingPayment'));

    try {
      setPhaseLabel(t('booking.phases.checkingSlot'));
      const slotCheck = await fetchAvailableSlots({
        barberId: barber.id,
        barberName: barber.name,
        dateLabel: date,
      });
      const stillOpen = slotCheck.slots?.some((s) => s.available && s.time === time);
      if (!stillOpen) {
        Alert.alert(t('booking.slotTakenTitle'), t('booking.slotTakenBody'));
        setStep(4);
        setTime(null);
        setAvailableSlots(slotCheck.slots || []);
        return;
      }

      calculateFinalBookingTotal({
        haircutPrice: Number.isFinite(servicePrice) && servicePrice > 0 ? servicePrice : FALLBACK_SERVICE_PRICE,
      });

      const redirectUri = Linking.createURL('paypal-booking/');
      console.log('[checkout] redirectUri:', redirectUri);
      console.log('[checkout] serviceId:', serviceId, 'barber:', barber?.name, barber?.id);

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
        serviceId,
        serviceName,
        redirectUri,
        customerEmail,
        customerName,
      });

      const { orderId, approveUrl, total, platformFee, haircutPrice, depositAmount: dep } = started;
      if (!orderId || !approveUrl) {
        throw new Error('Server did not return PayPal checkout');
      }

      setPhaseLabel(t('booking.phases.completePayment'));
      console.log('[checkout] opening PayPal approveUrl:', String(approveUrl).slice(0, 120));
      const browser = await WebBrowser.openAuthSessionAsync(approveUrl, redirectUri);
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

      const amountPaid = Number(b.amountPaid ?? b.amount_paid ?? b.amountCharged ?? b.amount_charged ?? 0);
      const balanceDue = Number(b.balanceDue ?? b.balance_due ?? b.remainingBalance ?? b.remaining_balance ?? 0);
      const platformFeePaid = Number(b.platformFee ?? b.platform_fee ?? platformFee);
      const servicePricePaid = Number(
        b.servicePrice ?? b.serviceAmountPaid ?? b.haircutPrice ?? b.service_price ?? servicePrice,
      );
      const tipPaid = Number(b.tipAmount ?? b.tip_amount ?? 0);
      const paymentStatus = String(b.paymentStatus ?? b.payment_status ?? '');
      const paymentMethod = String(b.paymentMethod ?? b.payment_method ?? 'paypal');
      const captureId = b.captureId ?? b.transactionId ?? b.paypal_capture_id ?? null;
      const isPaidInFull =
        b.isPaidInFull === true ||
        paymentStatus === 'paid_in_full' ||
        paymentStatus === 'paid_full' ||
        paymentStatus === 'paid';

      if (!captureId || amountPaid <= 0 || !isPaidInFull) {
        throw new Error('Payment failed — booking not confirmed.');
      }
      if (balanceDue > 0.01) {
        throw new Error('Payment failed — booking not confirmed.');
      }

      setSuccessPayload({
        bookingId: b.id,
        barber: b.barberName || barber?.name,
        service: b.service || selectedService?.name,
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
      if (finalized?.emailSent === false) {
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
      const paymentFailed =
        err?.code === 'payment_not_captured' ||
        err?.code === 'payment_balance_mismatch' ||
        /payment failed|not confirmed|not captured/i.test(String(err?.message || ''));
      const msg = paymentFailed
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
  const openSlotTimes = useMemo(
    () => availableSlots.filter((s) => s.available).map((s) => s.time),
    [availableSlots],
  );
  const hasOpenSlots = openSlotTimes.length > 0;

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
              <TouchableOpacity
                key={String(b.id || b.name)}
                onPress={() => {
                  setBarber(b);
                  setStep(2);
                }}
                style={styles.rowBtn}
              >
                <Text style={{ color: '#fff' }}>{b.name}</Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {step === 2 && (
          <>
            <Text style={{ color: '#fff', marginBottom: 10 }}>{t('booking.selectDate')}</Text>
            {dates.map((d) => (
              <TouchableOpacity
                key={d}
                onPress={() => {
                  setDate(d);
                  setSelectedService(null);
                  setTime(null);
                  setStep(3);
                }}
                style={styles.rowBtn}
              >
                <Text style={{ color: '#fff' }}>{dateDisplay(d)}</Text>
              </TouchableOpacity>
            ))}
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

            <Text style={styles.sectionTitle}>{t('booking.chooseService')}</Text>

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
                  selected={String(selectedService?.id) === String(service.id)}
                  onPress={() => setSelectedService(service)}
                />
              ))
            )}

            {!servicesLoading && servicesUsingFallback ? (
              <TouchableOpacity
                onPress={() => setServicesLoadKey((k) => k + 1)}
                style={styles.retryLink}
              >
                <Text style={styles.retryLinkText}>{t('booking.retryServices')}</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              disabled={!selectedService || servicesLoading}
              onPress={() => {
                if (selectedService) {
                  setTime(null);
                  setStep(4);
                }
              }}
              style={[
                styles.continueBtn,
                (!selectedService || servicesLoading) && styles.continueBtnDisabled,
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
              <Text style={styles.summaryValue}>{selectedService?.name || '—'}</Text>
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

            {!slotsLoading && !slotsError && !hasOpenSlots ? (
              <Text style={styles.emptyText}>{t('booking.noTimes')}</Text>
            ) : null}

            {!slotsLoading && hasOpenSlots ? (
              <AppointmentTimeDropdown
                value={time}
                options={openSlotTimes}
                disabled={slotsLoading}
                onSelect={(t) => setTime(t)}
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
            <Text style={{ color: '#FFD700', fontSize: 18, marginBottom: 10 }}>
              {t('booking.confirmTitle')}
            </Text>

            <Text style={{ color: '#fff' }}>{t('booking.barber')}: {barber?.name}</Text>
            <Text style={{ color: '#fff' }}>{t('booking.date')}: {dateDisplay(date)}</Text>
            <Text style={{ color: '#fff' }}>{t('booking.service')}: {selectedService?.name || '—'}</Text>
            <Text style={{ color: '#fff' }}>{t('booking.time')}: {time}</Text>

            <View
              style={{
                marginTop: 20,
                padding: 15,
                backgroundColor: '#111',
                borderRadius: 10,
              }}
            >
              <Text style={{ color: '#fff' }}>
                {selectedService?.name || t('booking.service')}: ${pricing.haircutPrice.toFixed(2)}
              </Text>
              <Text style={{ color: '#FFD700' }}>{t('booking.platformFee')}: ${pricing.platformFee.toFixed(2)}</Text>
              <Text style={{ color: '#fff', marginTop: 10, fontSize: 18 }}>
                {t('booking.totalPayPal')}: ${pricing.total.toFixed(2)}
              </Text>
              <Text style={{ color: '#666', fontSize: 12, marginTop: 8 }}>
                {t('booking.amountServerNote')}
              </Text>
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

            {phaseLabel ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 }}>
                <ActivityIndicator color="#FFD700" style={{ marginRight: 10 }} />
                <Text style={{ color: '#FFD700', flex: 1 }}>{phaseLabel}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              disabled={processingPayment}
              style={{
                marginTop: 20,
                padding: 15,
                backgroundColor: '#FFD700',
                borderRadius: 10,
                opacity: processingPayment ? 0.5 : 1,
              }}
              onPress={onConfirmPayAndBook}
            >
              <Text style={{ color: '#000', textAlign: 'center', fontWeight: '700' }}>
                {processingPayment
                  ? t('common.processing')
                  : t('booking.payWithPayPal', { amount: `$${pricing.total.toFixed(2)}` })}
              </Text>
            </TouchableOpacity>

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
  rowBtn: {
    padding: 15,
    marginBottom: 10,
    backgroundColor: UI.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: UI.border,
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
