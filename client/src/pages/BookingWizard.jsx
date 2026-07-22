import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { usePayPalScriptReducer } from "@paypal/react-paypal-js";
import {
  fetchAvailableSlots,
  fetchBarbersList,
  fetchBookingServices,
  finalizeAppBookingCheckout,
  pingBookingApi,
  startAppBookingCheckout,
} from "../services/appBookingApi.js";
import { calculateFinalBookingTotal, IFCDC_PLATFORM_FEE_USD } from "../lib/bookingPaymentTotals.js";
import { DEFAULT_BOOKING_SERVICES } from "../lib/defaultBookingServices.js";
import { mediaUrl } from "../services/api.js";
import { isRenderableStyleImageUrl } from "../lib/styleImageUrl.js";
import StyleCoverImage from "../components/StyleCoverImage.jsx";
import { looksLikePasswordResetToken } from "../lib/queryTokenRoutes.js";
import { subscribeScheduleUpdated, emitScheduleUpdated } from "../lib/scheduleEvents.js";
import { useLiveSlotRefresh } from "../lib/useLiveSlotRefresh.js";
import {
  bookingPayPalCancelUrl,
  bookingPayPalReturnUrl,
} from "../lib/bookingPayPalReturnUrl.js";
import ProviderTypeDropdown from "../components/ProviderTypeDropdown.jsx";
import { providerTypeLabel } from "../lib/providerTypes.js";
import BookingMonthCalendar from "../components/BookingMonthCalendar.jsx";
import { fetchMyLoyalty } from "../services/loyaltyApi.js";

const FALLBACK_SERVICE_PRICE = 25;
const CHECKOUT_STORAGE = "ifcdc_app_checkout_pending";

function estimateRewardDiscount(reward, services, subtotal) {
  if (!reward) return 0;
  const type = String(reward.reward_type || "").toLowerCase();
  const value = Math.max(0, Number(reward.reward_value) || 0);
  let discount = value;
  if (type === "discount_percent") discount = subtotal * Math.min(value, 100) / 100;
  if (type === "free_service" || type === "free_standard_haircut") {
    const eligible = Array.isArray(reward.eligible_services)
      ? reward.eligible_services.map((item) => String(item).toLowerCase())
      : [];
    const matching = services.filter((service) => {
      if (!eligible.length) return true;
      const id = String(service?.id || "").toLowerCase();
      const name = String(service?.name || "").toLowerCase();
      return eligible.some((allowed) => id === allowed || name.includes(allowed) || allowed.includes(name));
    });
    discount = matching.length ? Math.max(...matching.map((service) => Number(service?.price) || 0)) : 0;
    if (!discount && !eligible.length) discount = subtotal;
    if (value > 0) discount = Math.min(discount || value, value);
  }
  return Math.round(Math.max(0, Math.min(subtotal, discount)) * 100) / 100;
}

function buildDateOptions(count = 7) {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const options = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    if (i === 0) options.push("Today");
    else if (i === 1) options.push("Tomorrow");
    else options.push(days[d.getDay()]);
  }
  return options;
}

function readUser() {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}


export default function BookingWizard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ isResolved: isPayPalResolved }] = usePayPalScriptReducer();

  const [step, setStep] = useState(1);
  const [barber, setBarber] = useState(null);
  const [date, setDate] = useState(null);
  const [selectedServices, setSelectedServices] = useState([]);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesUsingFallback, setServicesUsingFallback] = useState(false);
  const [time, setTime] = useState(null);
  const [availableSlots, setAvailableSlots] = useState([]);
  const [unavailabilityMessage, setUnavailabilityMessage] = useState("");
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);
  const [guestEmail, setGuestEmail] = useState("");
  const [processingPayment, setProcessingPayment] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [successPayload, setSuccessPayload] = useState(null);
  const [barbers, setBarbers] = useState([]);
  const [barbersLoading, setBarbersLoading] = useState(true);
  const [barbersError, setBarbersError] = useState(null);
  const [providerFilter, setProviderFilter] = useState("");
  const [error, setError] = useState(null);
  const [slotsRefreshKey, setSlotsRefreshKey] = useState(0);
  const [availableRewards, setAvailableRewards] = useState([]);
  const [selectedRewardId, setSelectedRewardId] = useState("");
  const [tipAmount, setTipAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [payLaterEligible, setPayLaterEligible] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [promoMessage, setPromoMessage] = useState("");

  useEffect(() => subscribeScheduleUpdated(() => setSlotsRefreshKey((k) => k + 1)), []);
  useLiveSlotRefresh(
    useCallback(() => setSlotsRefreshKey((k) => k + 1), []),
    step === 4 && Boolean(barber && date),
  );

  const user = useMemo(() => readUser(), []);
  const cartTotalPrice = useMemo(
    () => selectedServices.reduce((sum, s) => sum + (Number(s?.price) || 0), 0),
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

  useEffect(() => {
    if (!isPayPalResolved || !window.paypal?.isFundingEligible || !window.paypal?.FUNDING?.PAYLATER) {
      setPayLaterEligible(false);
      return;
    }
    setPayLaterEligible(Boolean(window.paypal.isFundingEligible(window.paypal.FUNDING.PAYLATER)));
  }, [isPayPalResolved]);

  const applyPromoCode = () => {
    const normalized = promoCode.trim().toUpperCase();
    if (!normalized) {
      setPromoMessage("Enter a promo code.");
      return;
    }
    const promoReward = availableRewards.find(
      (reward) => String(reward?.metadata?.promoCode || reward?.metadata?.promo_code || "").toUpperCase() === normalized,
    );
    if (!promoReward) {
      setPromoMessage("This promo code is not available for this booking.");
      return;
    }
    setSelectedRewardId(promoReward.id);
    setPromoMessage(`${promoReward.title} applied.`);
  };

  useEffect(() => {
    let active = true;
    if (step !== 5 || !user?.email || !barber?.id) {
      setAvailableRewards([]);
      setSelectedRewardId("");
      return () => {
        active = false;
      };
    }
    fetchMyLoyalty(barber.id)
      .then((dashboard) => {
        if (!active) return;
        const barberValues = [barber.id, barber.name].map((value) => String(value || "").toLowerCase());
        const serviceValues = selectedServices.flatMap((service) =>
          [service.id, service.name].map((value) => String(value || "").toLowerCase()),
        );
        const eligible = (Array.isArray(dashboard.availableRewards) ? dashboard.availableRewards : []).filter((reward) => {
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

  const loadBarbers = useCallback(async () => {
    setBarbersLoading(true);
    setBarbersError(null);
    try {
      const list = await fetchBarbersList(providerFilter || undefined);
      const items = list
        .filter((b) => b && b.active !== false)
        .map((b) => ({
          id: b.id,
          name: String(b.name || "").trim(),
          providerType: b.providerType || b.provider_type || "barber",
        }))
        .filter((b) => b.name);
      setBarbers(items);
      if (!items.length) setBarbersError("No providers available right now.");
    } catch (e) {
      setBarbers([]);
      setBarbersError(e?.message || "Could not load providers.");
    } finally {
      setBarbersLoading(false);
    }
  }, [providerFilter]);

  useEffect(() => {
    void loadBarbers();
  }, [loadBarbers]);

  useEffect(() => {
    if (step !== 3 || !barber?.name) return;
    let cancelled = false;
    setServicesLoading(true);
    setServicesUsingFallback(false);
    (async () => {
      try {
        const result = await fetchBookingServices({ barberId: barber.id, barberName: barber.name });
        if (cancelled) return;
        const list = result.services?.length ? result.services : DEFAULT_BOOKING_SERVICES;
        setServices(list);
        setServicesUsingFallback(Boolean(result.usedLocalFallback));
        if (result.barberId != null) {
          setBarber((prev) => (prev ? { ...prev, id: result.barberId } : prev));
        }
      } catch {
        if (!cancelled) {
          setServices(DEFAULT_BOOKING_SERVICES);
          setServicesUsingFallback(true);
        }
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, barber?.id, barber?.name]);

  useEffect(() => {
    if (step !== 4 || !barber || !date) return;
    let cancelled = false;
    setSlotsLoading(true);
    setSlotsError(null);
    setAvailableSlots([]);
    setUnavailabilityMessage("");
    (async () => {
      try {
        const result = await fetchAvailableSlots({
          barberId: barber.id,
          barberName: barber.name,
          dateLabel: date,
          durationMinutes: cartTotalDuration,
        });
        if (!cancelled) {
          setAvailableSlots(result.slots || []);
          setUnavailabilityMessage(
            result.unavailability?.message ||
              (result.reasonIfEmpty === "blocked_date"
                ? "This provider is unavailable at this time. Please choose another available appointment."
                : ""),
          );
        }
      } catch (e) {
        if (!cancelled) {
          setAvailableSlots([]);
          setUnavailabilityMessage("");
          setSlotsError(e?.message || "Could not load available times.");
        }
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, barber, date, cartTotalDuration, slotsRefreshKey]);

  useEffect(() => {
    if (step !== 5) return;
    void pingBookingApi();
  }, [step]);

  /** PayPal return — finalize booking (same as the mobile app). */
  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) return;
    if (looksLikePasswordResetToken(token)) {
      navigate(`/reset-password?token=${encodeURIComponent(token)}`, { replace: true });
      return;
    }
    let cancelled = false;
    setProcessingPayment(true);
    setPhaseLabel("Confirming your booking…");
    (async () => {
      try {
        const finalized = await finalizeAppBookingCheckout(token);
        if (cancelled) return;
        const b = finalized?.booking;
        if (!b?.id) throw new Error("Booking not confirmed");
        setSuccessPayload({
          bookingId: b.id,
          barber: b.barberName,
          service: b.service,
          date: b.date,
          time: b.time,
          total: Number(b.total ?? b.totalDue ?? 0),
          platformFee: Number(b.platformFee ?? b.platform_fee ?? IFCDC_PLATFORM_FEE_USD),
          emailSent: finalized?.emailSent,
        });
        setStep(6);
        sessionStorage.removeItem(CHECKOUT_STORAGE);
        setSearchParams({}, { replace: true });
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || "Payment could not be confirmed.");
          setSearchParams({}, { replace: true });
        }
      } finally {
        if (!cancelled) {
          setProcessingPayment(false);
          setPhaseLabel("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams, navigate]);

  const resolveCustomerEmail = () => {
    const fromUser = String(user?.email || "").trim();
    if (fromUser) return fromUser;
    return String(guestEmail || "").trim();
  };

  const toggleService = (service) => {
    setSelectedServices((prev) => {
      const exists = prev.some((s) => String(s.id) === String(service.id));
      if (exists) return prev.filter((s) => String(s.id) !== String(service.id));
      return [...prev, service];
    });
  };

  const onConfirmPayAndBook = async () => {
    if (processingPayment || !barber?.name || !date || !time || !selectedServices.length) return;

    const customerEmail = resolveCustomerEmail();
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      setError("Enter your email so we can send your IFCDC booking confirmation after payment.");
      return;
    }

    setError(null);
    setProcessingPayment(true);
    setPhaseLabel("Checking availability…");

    try {
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
          (slotCheck.reasonIfEmpty === "blocked_date" || slotCheck.reasonIfEmpty === "closed_day"
            ? `${barber.name || "This provider"} is unavailable on this date. Please choose another available appointment.`
            : "That time was just taken. Pick another slot.");
        setError(closedMsg);
        setUnavailabilityMessage(slotCheck.unavailability?.message || "");
        setStep(4);
        setTime(null);
        setAvailableSlots(slotCheck.slots || []);
        return;
      }

      const redirectUri = bookingPayPalReturnUrl();
      const cancelUri = bookingPayPalCancelUrl();
      const barberUuid =
        typeof barber?.id === "string" && barber.id.includes("-") ? barber.id : undefined;

      setPhaseLabel("Creating secure checkout…");
      const started = await startAppBookingCheckout({
        barberName: barber.name,
        barberId: barber.id,
        barberUuid,
        dateLabel: date,
        timeLabel: time,
        serviceIds: selectedServices.map((s) => s.id),
        serviceId: selectedServices[0]?.id,
        serviceName: selectedServices.map((s) => s.name).join(", "),
        redirectUri,
        cancelUri,
        customerEmail,
        customerName: String(user?.name || "").trim() || "Web customer",
        rewardId: selectedRewardId || undefined,
        tipAmount,
        paymentMethod,
      });

      sessionStorage.setItem(
        CHECKOUT_STORAGE,
        JSON.stringify({
          barber: barber.name,
          date,
          time,
          service: selectedServices.map((s) => s.name).join(", "),
          orderId: started.orderId,
        }),
      );

      setPhaseLabel("Redirecting to PayPal…");
      window.location.href = started.approveUrl;
    } catch (e) {
      setError(e?.message || "Checkout failed. Please try again.");
      setPhaseLabel("");
    } finally {
      // Always clear unless we navigated away to PayPal (page unload). Prevents stuck "Processing…"
      // when slot checks fail or start errors.
      setProcessingPayment(false);
    }
  };

  const resetFlow = () => {
    setStep(1);
    setBarber(null);
    setDate(null);
    setSelectedServices([]);
    setServices([]);
    setTime(null);
    setAvailableSlots([]);
    setSuccessPayload(null);
    setSelectedRewardId("");
    setTipAmount(0);
    setPaymentMethod("card");
    setPromoCode("");
    setPromoMessage("");
    setError(null);
    setPhaseLabel("");
  };

  if (step === 6 && successPayload) {
    return (
      <div className="ifcdc-book-wizard ifcdc-book-wizard--success">
        <h1 className="ifcdc-page-title">Booking confirmed</h1>
        <p className="ifcdc-page-lead">Payment received — your appointment is saved.</p>
        <div className="ifcdc-book-wizard__summary">
          <p>
            <strong>Booking ID:</strong> {successPayload.bookingId}
          </p>
          <p>
            <strong>Barber:</strong> {successPayload.barber}
          </p>
          <p>
            <strong>Service:</strong> {successPayload.service}
          </p>
          <p>
            <strong>When:</strong> {successPayload.date} at {successPayload.time}
          </p>
          <p>
            <strong>Total:</strong> ${Number(successPayload.total || pricing.total).toFixed(2)}
          </p>
          {successPayload.emailSent === false ? (
            <p className="ifcdc-error-msg" role="alert">
              Confirmation email could not be sent — save your booking ID and contact IFCDC support.
            </p>
          ) : (
            <p className="ifcdc-page-hint">Check your email for the IFCDC confirmation.</p>
          )}
        </div>
        <button type="button" className="ifcdc-book-wizard__cta" onClick={() => navigate("/")}>
          Back to Home
        </button>
        <button type="button" className="ifcdc-book-wizard__cta ifcdc-book-wizard__cta--ghost" onClick={resetFlow}>
          Book another
        </button>
      </div>
    );
  }

  return (
    <div className="ifcdc-book-wizard">
      <h1 className="ifcdc-page-title">Book appointment</h1>
      <p className="ifcdc-page-lead">
        Step {step} of 5 — secure PayPal checkout with instant confirmation.
      </p>

      <div className="ifcdc-book-wizard__steps" aria-hidden>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={`ifcdc-book-wizard__dot${step >= n ? " ifcdc-book-wizard__dot--on" : ""}`} />
        ))}
      </div>

      {error ? (
        <p className="ifcdc-error-msg" role="alert">
          {error}
        </p>
      ) : null}
      {phaseLabel ? <p className="ifcdc-page-hint">{phaseLabel}</p> : null}

      {step === 1 ? (
        <section className="ifcdc-book-wizard__panel">
          <h2 className="ifcdc-book-wizard__heading">Choose your provider</h2>
          <ProviderTypeDropdown
            label="Filter by provider type"
            includeAll
            value={providerFilter}
            disabled={barbersLoading}
            onChange={(value) => {
              setProviderFilter(value);
              setBarber(null);
            }}
          />
          <div style={{ height: 12 }} />
          {barbersLoading ? <p className="ifcdc-page-hint">Loading providers…</p> : null}
          {barbersError ? <p className="ifcdc-error-msg">{barbersError}</p> : null}
          <ul className="ifcdc-book-wizard__list">
            {barbers.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className={`ifcdc-book-wizard__pick${barber?.id === b.id ? " ifcdc-book-wizard__pick--on" : ""}`}
                  onClick={() => {
                    setBarber(b);
                    setStep(2);
                    setError(null);
                  }}
                >
                  {b.name}
                  <span style={{ display: "block", fontSize: 12, opacity: 0.7 }}>
                    {providerTypeLabel(b.providerType)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="ifcdc-book-wizard__panel">
          <h2 className="ifcdc-book-wizard__heading">Pick a date</h2>
          <p className="ifcdc-page-hint">Barber: {barber?.name}</p>
          <BookingMonthCalendar
            barberId={barber?.id}
            barberName={barber?.name}
            value={date}
            durationMinutes={30}
            onSelectDate={(ymd) => {
              setDate(ymd);
              setStep(3);
              setError(null);
            }}
          />
          <button type="button" className="ifcdc-book-wizard__back" onClick={() => setStep(1)}>
            ← Change barber
          </button>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="ifcdc-book-wizard__panel">
          <h2 className="ifcdc-book-wizard__heading">Choose services</h2>
          <p className="ifcdc-page-hint">
            {barber?.name} · {date} · select one or more
            {servicesUsingFallback ? " · offline menu" : ""}
          </p>
          {servicesLoading ? <p className="ifcdc-page-hint">Loading services…</p> : null}
          <ul className="ifcdc-book-wizard__services">
            {services.map((s) => {
              const selected = selectedServices.some((x) => String(x.id) === String(s.id));
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`ifcdc-book-wizard__service${selected ? " ifcdc-book-wizard__service--on" : ""}`}
                    onClick={() => toggleService(s)}
                  >
                    <div className="ifcdc-cover-media ifcdc-book-wizard__service-img">
                      <StyleCoverImage
                        bare
                        styleId={s.id}
                        barberId={barber?.id}
                        imageUrl={isRenderableStyleImageUrl(s.image_url) ? s.image_url : ""}
                        alt={s.name || ""}
                        className="ifcdc-cover-media__img ifcdc-cover-fill"
                        logContext="booking-wizard"
                      />
                    </div>
                    <div className="ifcdc-book-wizard__service-copy">
                      <strong>{s.name}</strong>
                      {s.description ? <span>{s.description}</span> : null}
                      <span className="ifcdc-book-wizard__service-price">
                        ${Number(s.price || 0).toFixed(2)} · {s.duration_minutes || 30} min
                      </span>
                    </div>
                    {selected ? <span className="ifcdc-book-wizard__check">✓</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {selectedServices.length ? (
            <div className="ifcdc-book-wizard__summary" style={{ marginBottom: 16 }}>
              <p>
                <strong>Cart ({cartTotalDuration} min)</strong>
              </p>
              {selectedServices.map((s) => (
                <p key={s.id}>
                  {s.name} — ${Number(s.price || 0).toFixed(2)}
                </p>
              ))}
              <p>
                <strong>Services total:</strong> ${cartTotalPrice.toFixed(2)}
              </p>
            </div>
          ) : null}
          <button
            type="button"
            className="ifcdc-book-wizard__cta"
            disabled={!selectedServices.length}
            onClick={() => {
              setTime(null);
              setStep(4);
              setError(null);
            }}
          >
            Continue
          </button>
          <button type="button" className="ifcdc-book-wizard__back" onClick={() => setStep(2)}>
            ← Change date
          </button>
        </section>
      ) : null}

      {step === 4 ? (
        <section className="ifcdc-book-wizard__panel">
          <h2 className="ifcdc-book-wizard__heading">Select a time</h2>
          <p className="ifcdc-page-hint">
            {barber?.name} · {date} · {selectedServices.map((s) => s.name).join(", ")} · {cartTotalDuration} min
          </p>
          {slotsLoading ? <p className="ifcdc-page-hint">Loading times…</p> : null}
          {slotsError ? <p className="ifcdc-error-msg">{slotsError}</p> : null}
          {!slotsLoading && !availableSlots.length ? (
            <p className={`ifcdc-page-hint${unavailabilityMessage ? " ifcdc-book-wizard__unavailable-msg" : ""}`}>
              {unavailabilityMessage || "No times for this date. Try another day."}
            </p>
          ) : null}
          <ul className="ifcdc-book-wizard__list ifcdc-book-wizard__list--grid">
            {availableSlots.map((slot) => {
              const t = slot.time;
              const available = slot.available !== false;
              return (
              <li key={t}>
                <button
                  type="button"
                  disabled={!available}
                  className={`ifcdc-book-wizard__pick${time === t ? " ifcdc-book-wizard__pick--on" : ""}${!available ? " ifcdc-book-wizard__pick--disabled" : ""}`}
                  onClick={() => {
                    if (!available) return;
                    setTime(t);
                    setStep(5);
                    setError(null);
                  }}
                >
                  {t}
                  {!available ? (
                    <span className="ifcdc-book-wizard__pick-tag">
                      {slot.reason === "booked" ? "Booked" : "Unavailable"}
                    </span>
                  ) : null}
                </button>
              </li>
            );
            })}
          </ul>
          <button type="button" className="ifcdc-book-wizard__back" onClick={() => setStep(3)}>
            ← Change service
          </button>
        </section>
      ) : null}

      {step === 5 ? (
        <section className="ifcdc-book-wizard__panel ifcdc-checkout">
          <div className="ifcdc-checkout__header">
            <span className="ifcdc-checkout__lock" aria-hidden="true">🔒</span>
            <div>
              <h2 className="ifcdc-checkout__title">Secure Checkout</h2>
              <p>Choose your preferred payment method.</p>
            </div>
          </div>

          {user?.email && availableRewards.length ? (
            <div className="ifcdc-checkout__section">
              <h3>Available rewards</h3>
              <label className="ifcdc-checkout__reward">
                <input
                  type="radio"
                  name="loyalty-reward"
                  checked={!selectedRewardId}
                  onChange={() => {
                    setSelectedRewardId("");
                    setPromoMessage("");
                  }}
                />
                No reward
              </label>
              {availableRewards.map((reward) => (
                <label key={reward.id} className="ifcdc-checkout__reward">
                  <input
                    type="radio"
                    name="loyalty-reward"
                    checked={selectedRewardId === reward.id}
                    onChange={() => {
                      setSelectedRewardId(reward.id);
                      setPromoMessage("");
                    }}
                  />
                  <span>
                    <strong>Redeem {reward.title}</strong>
                    <small>
                      {reward.points_cost} points
                      {Number(reward.reward_value) > 0 ? ` · $${Number(reward.reward_value).toFixed(2)} value` : ""}
                    </small>
                  </span>
                </label>
              ))}
              <small className="ifcdc-checkout__muted">
                Points are reserved at checkout and redeemed only after the paid appointment is completed.
              </small>
            </div>
          ) : null}

          <div className="ifcdc-checkout__section">
            <h3>Apply promo code</h3>
            <div className="ifcdc-checkout__promo">
              <input
                type="text"
                value={promoCode}
                onChange={(event) => {
                  setPromoCode(event.target.value);
                  setPromoMessage("");
                }}
                placeholder="Promo code"
                autoCapitalize="characters"
              />
              <button type="button" onClick={applyPromoCode}>Apply</button>
            </div>
            {promoMessage ? <small className="ifcdc-checkout__muted">{promoMessage}</small> : null}
          </div>

          <div className="ifcdc-checkout__section">
            <h3>Add a tip</h3>
            <div className="ifcdc-checkout__tips">
              {[0, 15, 20, 25].map((percent) => {
                const amount = Math.round(cartTotalPrice * percent) / 100;
                return (
                  <button
                    key={percent}
                    type="button"
                    className={Math.abs(tipAmount - amount) < 0.01 ? "is-selected" : ""}
                    onClick={() => setTipAmount(amount)}
                  >
                    {percent ? `${percent}%` : "No tip"}
                  </button>
                );
              })}
              <label>
                Custom
                <input
                  type="number"
                  min="0"
                  max="500"
                  step="0.01"
                  value={tipAmount}
                  onChange={(event) => setTipAmount(Math.max(0, Math.min(500, Number(event.target.value) || 0)))}
                />
              </label>
            </div>
          </div>

          <div className="ifcdc-checkout__summary" aria-label="Booking summary">
            <h3>Booking summary</h3>
            <div><span>Service</span><strong>{selectedServices.map((s) => s.name).join(", ")}</strong></div>
            <div><span>Barber</span><strong>{barber?.name}</strong></div>
            <div><span>Date</span><strong>{date}</strong></div>
            <div><span>Time</span><strong>{time}</strong></div>
            <div><span>Tip</span><strong>${pricing.tipAmount.toFixed(2)}</strong></div>
            <div><span>Discount</span><strong>−${pricing.discountAmount.toFixed(2)}</strong></div>
            <div><span>Platform fee</span><strong>${pricing.platformFee.toFixed(2)}</strong></div>
            <div className="ifcdc-checkout__total"><span>Total</span><strong>${pricing.total.toFixed(2)}</strong></div>
          </div>

          {!user?.email ? (
            <label className="ifcdc-label" htmlFor="bk-guest-email">
              Email for confirmation
              <input
                id="bk-guest-email"
                type="email"
                className="ifcdc-input"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
          ) : (
            <p className="ifcdc-page-hint">Confirmation will be sent to {user.email}</p>
          )}

          <div className="ifcdc-checkout__methods">
            <button
              type="button"
              className={`ifcdc-checkout__method ifcdc-checkout__method--card ${paymentMethod === "card" ? "is-selected" : ""}`}
              onClick={() => setPaymentMethod("card")}
            >
              <span className="ifcdc-checkout__method-icon" aria-hidden="true">💳</span>
              <span>
                <strong>Pay with Debit or Credit Card</strong>
                <small>Visa, Mastercard, American Express, Discover, and other supported cards.</small>
              </span>
              <span className="ifcdc-checkout__radio" aria-hidden="true">{paymentMethod === "card" ? "●" : "○"}</span>
            </button>
            <button
              type="button"
              className={`ifcdc-checkout__method ${paymentMethod === "paypal" ? "is-selected" : ""}`}
              onClick={() => setPaymentMethod("paypal")}
            >
              <span className="ifcdc-checkout__method-icon" aria-hidden="true">🅿️</span>
              <span>
                <strong>Pay with PayPal</strong>
                <small>Sign in with your PayPal account if you prefer.</small>
              </span>
              <span className="ifcdc-checkout__radio" aria-hidden="true">{paymentMethod === "paypal" ? "●" : "○"}</span>
            </button>
            {payLaterEligible ? (
              <button
                type="button"
                className={`ifcdc-checkout__method ${paymentMethod === "paylater" ? "is-selected" : ""}`}
                onClick={() => setPaymentMethod("paylater")}
              >
                <span className="ifcdc-checkout__method-icon" aria-hidden="true">⏳</span>
                <span>
                  <strong>Pay Later</strong>
                  <small>Choose an eligible PayPal Pay Later offer.</small>
                </span>
                <span className="ifcdc-checkout__radio" aria-hidden="true">{paymentMethod === "paylater" ? "●" : "○"}</span>
              </button>
            ) : null}
          </div>

          <p className="ifcdc-checkout__card-note">
            No PayPal account required. Pay securely with your debit or credit card.
          </p>

          <button
            type="button"
            className="ifcdc-book-wizard__cta"
            disabled={processingPayment}
            onClick={() => void onConfirmPayAndBook()}
          >
            {processingPayment
              ? "Processing…"
              : paymentMethod === "card"
                ? `Continue with Card · $${pricing.total.toFixed(2)}`
                : paymentMethod === "paylater"
                  ? `Continue with Pay Later · $${pricing.total.toFixed(2)}`
                  : `Continue with PayPal · $${pricing.total.toFixed(2)}`}
          </button>
          <p className="ifcdc-checkout__powered">IFCDC Barbers checkout · Securely powered by PayPal</p>
          <button type="button" className="ifcdc-book-wizard__back" onClick={() => setStep(4)} disabled={processingPayment}>
            ← Change time
          </button>
          {!user ? (
            <p className="ifcdc-page-hint">
              Have an account? <Link to="/login">Sign in</Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
