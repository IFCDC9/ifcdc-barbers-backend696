import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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

const FALLBACK_SERVICE_PRICE = 25;
const CHECKOUT_STORAGE = "ifcdc_app_checkout_pending";

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

  const [step, setStep] = useState(1);
  const [barber, setBarber] = useState(null);
  const [date, setDate] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesUsingFallback, setServicesUsingFallback] = useState(false);
  const [time, setTime] = useState(null);
  const [availableSlots, setAvailableSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);
  const [guestEmail, setGuestEmail] = useState("");
  const [processingPayment, setProcessingPayment] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [successPayload, setSuccessPayload] = useState(null);
  const [barbers, setBarbers] = useState([]);
  const [barbersLoading, setBarbersLoading] = useState(true);
  const [barbersError, setBarbersError] = useState(null);
  const [error, setError] = useState(null);

  const dates = useMemo(() => buildDateOptions(7), []);
  const user = useMemo(() => readUser(), []);
  const servicePrice = Number(selectedService?.price);

  const pricing = useMemo(
    () =>
      calculateFinalBookingTotal({
        haircutPrice:
          Number.isFinite(servicePrice) && servicePrice > 0 ? servicePrice : FALLBACK_SERVICE_PRICE,
      }),
    [servicePrice],
  );

  const openSlotTimes = useMemo(
    () => availableSlots.filter((s) => s.available).map((s) => s.time),
    [availableSlots],
  );

  const loadBarbers = useCallback(async () => {
    setBarbersLoading(true);
    setBarbersError(null);
    try {
      const list = await fetchBarbersList();
      const items = list
        .filter((b) => b && b.active !== false)
        .map((b) => ({ id: b.id, name: String(b.name || "").trim() }))
        .filter((b) => b.name);
      setBarbers(items);
      if (!items.length) setBarbersError("No barbers available right now.");
    } catch (e) {
      setBarbers([]);
      setBarbersError(e?.message || "Could not load barbers.");
    } finally {
      setBarbersLoading(false);
    }
  }, []);

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
    (async () => {
      try {
        const result = await fetchAvailableSlots({
          barberId: barber.id,
          barberName: barber.name,
          dateLabel: date,
        });
        if (!cancelled) setAvailableSlots(result.slots || []);
      } catch (e) {
        if (!cancelled) {
          setAvailableSlots([]);
          setSlotsError(e?.message || "Could not load available times.");
        }
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, barber, date]);

  useEffect(() => {
    if (step !== 5) return;
    void pingBookingApi();
  }, [step]);

  /** PayPal return — finalize booking (same as TestFlight app). */
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

  const onConfirmPayAndBook = async () => {
    if (processingPayment || !barber?.name || !date || !time || !selectedService?.id) return;

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
      });
      const stillOpen = slotCheck.slots?.some((s) => s.available && s.time === time);
      if (!stillOpen) {
        setError("That time was just taken. Pick another slot.");
        setStep(4);
        setTime(null);
        setAvailableSlots(slotCheck.slots || []);
        return;
      }

      const redirectUri = `${window.location.origin}/booking`;
      const barberUuid =
        typeof barber?.id === "string" && barber.id.includes("-") ? barber.id : undefined;

      setPhaseLabel("Creating secure checkout…");
      const started = await startAppBookingCheckout({
        barberName: barber.name,
        barberId: barber.id,
        barberUuid,
        dateLabel: date,
        timeLabel: time,
        serviceId: selectedService.id,
        serviceName: selectedService.name,
        redirectUri,
        customerEmail,
        customerName: String(user?.name || "").trim() || "Web customer",
      });

      sessionStorage.setItem(
        CHECKOUT_STORAGE,
        JSON.stringify({
          barber: barber.name,
          date,
          time,
          service: selectedService.name,
          orderId: started.orderId,
        }),
      );

      setPhaseLabel("Redirecting to PayPal…");
      window.location.href = started.approveUrl;
    } catch (e) {
      setError(e?.message || "Checkout failed. Please try again.");
      setProcessingPayment(false);
      setPhaseLabel("");
    }
  };

  const resetFlow = () => {
    setStep(1);
    setBarber(null);
    setDate(null);
    setSelectedService(null);
    setServices([]);
    setTime(null);
    setAvailableSlots([]);
    setSuccessPayload(null);
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
          <h2 className="ifcdc-book-wizard__heading">Choose your barber</h2>
          {barbersLoading ? <p className="ifcdc-page-hint">Loading barbers…</p> : null}
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
          <ul className="ifcdc-book-wizard__list ifcdc-book-wizard__list--grid">
            {dates.map((d) => (
              <li key={d}>
                <button
                  type="button"
                  className={`ifcdc-book-wizard__pick${date === d ? " ifcdc-book-wizard__pick--on" : ""}`}
                  onClick={() => {
                    setDate(d);
                    setStep(3);
                    setError(null);
                  }}
                >
                  {d}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="ifcdc-book-wizard__back" onClick={() => setStep(1)}>
            ← Change barber
          </button>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="ifcdc-book-wizard__panel">
          <h2 className="ifcdc-book-wizard__heading">Choose a service</h2>
          <p className="ifcdc-page-hint">
            {barber?.name} · {date}
            {servicesUsingFallback ? " · offline menu" : ""}
          </p>
          {servicesLoading ? <p className="ifcdc-page-hint">Loading services…</p> : null}
          <ul className="ifcdc-book-wizard__services">
            {services.map((s) => {
              const selected = String(selectedService?.id) === String(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`ifcdc-book-wizard__service${selected ? " ifcdc-book-wizard__service--on" : ""}`}
                    onClick={() => setSelectedService(s)}
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
          <button
            type="button"
            className="ifcdc-book-wizard__cta"
            disabled={!selectedService}
            onClick={() => {
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
            {barber?.name} · {date} · {selectedService?.name}
          </p>
          {slotsLoading ? <p className="ifcdc-page-hint">Loading times…</p> : null}
          {slotsError ? <p className="ifcdc-error-msg">{slotsError}</p> : null}
          {!slotsLoading && !openSlotTimes.length ? (
            <p className="ifcdc-page-hint">No open times for this date. Try another day.</p>
          ) : null}
          <ul className="ifcdc-book-wizard__list ifcdc-book-wizard__list--grid">
            {openSlotTimes.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  className={`ifcdc-book-wizard__pick${time === t ? " ifcdc-book-wizard__pick--on" : ""}`}
                  onClick={() => {
                    setTime(t);
                    setStep(5);
                    setError(null);
                  }}
                >
                  {t}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="ifcdc-book-wizard__back" onClick={() => setStep(3)}>
            ← Change service
          </button>
        </section>
      ) : null}

      {step === 5 ? (
        <section className="ifcdc-book-wizard__panel">
          <h2 className="ifcdc-book-wizard__heading">Review &amp; pay</h2>
          <div className="ifcdc-book-wizard__summary">
            <p>
              <strong>Barber:</strong> {barber?.name}
            </p>
            <p>
              <strong>Service:</strong> {selectedService?.name}
            </p>
            <p>
              <strong>When:</strong> {date} at {time}
            </p>
            <p>
              <strong>Service price:</strong> ${pricing.haircutPrice.toFixed(2)}
            </p>
            <p>
              <strong>Platform fee:</strong> ${pricing.platformFee.toFixed(2)}
            </p>
            <p>
              <strong>Total due today:</strong> ${pricing.total.toFixed(2)}
            </p>
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

          <button
            type="button"
            className="ifcdc-book-wizard__cta"
            disabled={processingPayment}
            onClick={() => void onConfirmPayAndBook()}
          >
            {processingPayment ? "Processing…" : "Pay with PayPal"}
          </button>
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
