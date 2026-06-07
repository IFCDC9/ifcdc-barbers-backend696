import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { PayPalButtons, usePayPalScriptReducer } from "@paypal/react-paypal-js";
import { getApiOrigin, getBarbers, mediaUrl, fetchBarberPublicPricing, fetchBookingQuote } from "../services/api.js";
import StyleCoverImage from "../components/StyleCoverImage.jsx";
import { isRenderableStyleImageUrl } from "../lib/styleImageUrl.js";
import { computeChargeBreakdown, normalizeCheckoutBreakdown } from "../lib/stylePricing.js";
import {
  canOpenDirectionsToShop,
  hasShopCoords,
  mapsEmbedSrcForShop,
  openDirectionsToShop,
  shopAddressText,
} from "../lib/shopDirections.js";
import { AURA_BOOKING_FORM_PREFILL_KEY } from "../lib/auraBookingPrefill.js";

const STYLE_SESSION_KEY = "ifcdc_selected_booking_style";

const SERVICE_OPTIONS = [
  "Haircut",
  "Beard trim",
  "Haircut + beard",
  "Kids cut",
  "Lineup / shape-up",
  "Other",
];

function defaultPriceFromEnv() {
  const n = Number(import.meta.env.VITE_BOOKING_PRICE);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function maskClientId(id) {
  const s = String(id ?? "").trim();
  if (s.length <= 8) return s || "(missing)";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function formatPayPalError(err) {
  if (typeof err === "string") return err;
  if (err?.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isFormReady(form) {
  return (
    Boolean(form.name?.trim()) &&
    Boolean(form.email?.trim()) &&
    Boolean(form.date) &&
    Boolean(form.time) &&
    Boolean(form.barber?.trim()) &&
    Boolean(form.service?.trim())
  );
}

function normalizeSavedBooking(b) {
  if (!b) return null;
  const rem = Number(b.remainingBalance ?? b.remaining_balance ?? 0);
  const raw = b.rawPaymentStatus ?? b.payment_status;
  let ps = b.paymentStatus;
  if (!ps && (raw === "paid" || raw === "paid_full" || raw === "paid_in_full")) ps = "paid_in_full";
  const tip = Number(b.tipAmount ?? b.tip_amount ?? 0);
  const totalPaid = Number(b.totalPaid ?? b.total_paid ?? 0);
  return { ...b, remainingBalance: rem, paymentStatus: ps, tipAmount: tip, totalPaid };
}

function formatAppointmentDisplay(dateStr, timeStr) {
  if (!dateStr || !timeStr) return "—";
  const d = new Date(`${dateStr}T${timeStr}:00`);
  if (Number.isNaN(d.getTime())) return `${dateStr} · ${timeStr}`;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * PayPal Smart Buttons: create-order → capture-order → POST /api/book (paymentId required when paying via platform).
 */
function BookingPayPalBlock({
  form,
  chargeAmountUsd,
  paymentType,
  totalPriceUsd,
  styleId,
  barberId,
  tipPercent,
  tipAmount,
  setPaid,
  setStatus,
  setFlowPhase,
  bookBodyExtra = {},
  onBookingSaved,
}) {
  const [scriptState] = usePayPalScriptReducer();
  const { isPending, isRejected, loadingStatus, loadingStatusErrorMessage, options } = scriptState;

  const formReady = useMemo(() => isFormReady(form), [form]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log("[PayPal] script:", loadingStatus, {
      clientId: maskClientId(options?.["client-id"]),
      environment: options?.environment,
    });
  }, [loadingStatus, options?.["client-id"], options?.environment]);

  const apiOrigin = getApiOrigin();
  const bookUrl = `${apiOrigin}/api/book`;
  const paymentsBase = `${apiOrigin}/api/paypal`;

  return (
    <>
      {isPending ? (
        <p className="paypal-script-status paypal-script-status--pending ifcdc-loading" role="status">
          Loading PayPal…
        </p>
      ) : null}
      {isRejected ? (
        <div className="paypal-script-status paypal-script-status--error" role="alert">
          <p>
            PayPal script failed to load
            {loadingStatusErrorMessage ? `: ${loadingStatusErrorMessage}` : "."}
          </p>
          <p className="paypal-fix-hint">
            On Render, set <code>VITE_PAYPAL_CLIENT_ID</code> (same Live ID as backend <code>PAYPAL_CLIENT_ID</code>) and{" "}
            <code>VITE_PAYPAL_ENVIRONMENT=production</code>, then redeploy the static site. Local: <code>client/.env</code>.
          </p>
        </div>
      ) : null}

      {!isRejected ? (
        <PayPalButtons
          disabled={!formReady}
          style={{ layout: "vertical", label: "paypal", shape: "rect", color: "gold" }}
          createOrder={async () => {
            if (!formReady) {
              setStatus("Fill name, email, date, time, barber, and service before paying.");
              throw new Error("form_incomplete");
            }
            setStatus(null);
            try {
              const res = await fetch(`${paymentsBase}/create-order`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({
                  styleId,
                  barberId,
                  paymentType,
                  ...(Number(tipPercent) > 0 ? { tipPercent: Number(tipPercent) } : {}),
                  ...(Number(tipAmount) > 0 ? { tipAmount: Number(tipAmount) } : {}),
                  currency: "USD",
                  description: `IFCDC Barbers — ${form.service} with ${form.barber} (full payment)`,
                }),
              });
              const payload = await res.json().catch(() => ({}));
              if (!res.ok) {
                const m =
                  payload.message || payload.error || `Create order failed (HTTP ${res.status})`;
                console.error("[PAYMENT] create-order HTTP error:", res.status, payload);
                setStatus(m);
                throw new Error(m);
              }
              const orderID = payload.orderID || payload.id;
              if (!orderID) {
                console.error("[PAYMENT] create-order: missing order id in response", payload);
                setStatus("Server did not return an order id.");
                throw new Error("no_order_id");
              }
              if (import.meta.env.DEV) {
                console.log("[PayPal] create-order →", orderID);
              }
              return orderID;
            } catch (err) {
              if (err?.message !== "form_incomplete") {
                console.error("[PayPal] createOrder failed:", err);
              }
              throw err;
            }
          }}
          onCancel={() => {
            setFlowPhase("idle");
            setStatus("Payment cancelled.");
          }}
          onApprove={async (data) => {
            setFlowPhase("capturing");
            setStatus(null);
            try {
              const capRes = await fetch(`${paymentsBase}/capture-order`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ orderID: data.orderID }),
              });
              const capture = await capRes.json().catch(() => ({}));

              console.log("PAYPAL CAPTURE (client):", capture);
              console.log("CAPTURE ID:", capture.captureId ?? "(none)");

              if (!capRes.ok) {
                const m =
                  capture.message ||
                  capture.error ||
                  `Payment capture failed (HTTP ${capRes.status})`;
                console.error("[PAYMENT] capture-order failed:", m, capture);
                setFlowPhase("error");
                setStatus(m);
                return;
              }

              if (!capture.success || !capture.captureId) {
                console.error("[PAYMENT] missing captureId — booking blocked", capture);
                setFlowPhase("error");
                setStatus("Payment capture failed — no capture id. Booking was not saved.");
                return;
              }

              const paymentId = String(capture.captureId).trim();
              console.log("CAPTURE ID (using for booking):", paymentId);

              setFlowPhase("saving");
              const bookBody = {
                name: form.name.trim(),
                email: form.email.trim(),
                date: form.date,
                time: form.time,
                service: form.service.trim(),
                barber: form.barber.trim(),
                styleId,
                price: totalPriceUsd,
                paymentType,
                ...(form.barberId != null && form.barberId !== ""
                  ? { barberId: String(form.barberId) }
                  : {}),
                ...(Number(tipPercent) > 0 ? { tipPercent: Number(tipPercent) } : {}),
                ...(Number(tipAmount) > 0 ? { tipAmount: Number(tipAmount) } : {}),
                paymentId,
                paypalOrderId: data.orderID,
                ...bookBodyExtra,
              };

              const bookRes = await fetch(bookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(bookBody),
              });
              const text = await bookRes.text();
              let payload = {};
              try {
                payload = text ? JSON.parse(text) : {};
              } catch {
                payload = {};
              }

              if (!bookRes.ok) {
                const errMsg =
                  payload?.message ||
                  payload?.error ||
                  text?.slice(0, 240) ||
                  `Booking failed (HTTP ${bookRes.status})`;
                console.error("[bookings] POST /api/book failed:", bookRes.status, payload);
                setFlowPhase("error");
                setStatus(errMsg);
                return;
              }

              console.log("BOOKING SAVED", payload?.booking?.id ?? payload?.booking);
              if (payload?.emailSent) {
                console.log("EMAIL SENT");
              }

              setPaid(true);
              setFlowPhase("success");
              if (typeof onBookingSaved === "function") {
                onBookingSaved(normalizeSavedBooking(payload?.booking));
              }
              if (payload.emailSent === false || payload.email === "failed") {
                setStatus(
                  payload.emailError
                    ? `Booking saved — email not sent: ${payload.emailError}`
                    : "Booking saved — confirmation email could not be sent."
                );
              } else {
                setStatus(null);
              }
            } catch (err) {
              console.error("[PAYMENT] onApprove error:", err?.message || err);
              setFlowPhase("error");
              setStatus(err?.message || "Payment or booking failed.");
            }
          }}
          onError={(err) => {
            console.error("[PayPal] Buttons onError:", err);
            setFlowPhase("error");
            setStatus(formatPayPalError(err) || "PayPal error");
          }}
        >
          <p className="paypal-buttons-fallback">
            PayPal could not render. Check client id, ad blockers, and try again.
          </p>
        </PayPalButtons>
      ) : null}
    </>
  );
}

export default function Booking() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const selectedStyle = useMemo(() => {
    const fromState = location.state?.selectedStyle;
    if (fromState?.styleId) return fromState;
    try {
      const raw = sessionStorage.getItem(STYLE_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, [location.state]);

  const stylePriceUsd = useMemo(() => {
    if (selectedStyle && Number(selectedStyle.price) > 0) {
      return Math.round(Number(selectedStyle.price) * 100) / 100;
    }
    const q = Number(searchParams.get("price"));
    if (Number.isFinite(q) && q > 0) return Math.min(9999, q);
    return defaultPriceFromEnv();
  }, [selectedStyle, searchParams]);

  const [tipChoice, setTipChoice] = useState("none");
  const [customTip, setCustomTip] = useState("");

  const tipOpts = useMemo(() => {
    if (tipChoice === "custom") {
      const n = Number(customTip);
      return Number.isFinite(n) && n > 0 ? { tipAmount: n } : {};
    }
    if (tipChoice === "none") return {};
    const p = Number(tipChoice);
    return Number.isFinite(p) ? { tipPercent: p } : {};
  }, [tipChoice, customTip]);

  const [barberPricing, setBarberPricing] = useState(null);
  const [serverQuote, setServerQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const [savedBookingSnapshot, setSavedBookingSnapshot] = useState(null);

  const breakdown = useMemo(() => {
    if (serverQuote?.breakdown && selectedStyle?.styleId) {
      return normalizeCheckoutBreakdown(serverQuote.breakdown, barberPricing);
    }
    return computeChargeBreakdown(stylePriceUsd, "full", tipOpts, barberPricing);
  }, [serverQuote, selectedStyle?.styleId, stylePriceUsd, tipOpts, barberPricing]);

  const chargeAmountUsd = breakdown.paypalTotal;

  const [form, setForm] = useState({
    name: "",
    email: "",
    date: "",
    time: "",
    barber: "",
    barberId: undefined,
    service: "",
  });

  const [barberOptions, setBarberOptions] = useState([]);
  const [paid, setPaid] = useState(false);
  const [status, setStatus] = useState(null);
  const [flowPhase, setFlowPhase] = useState("idle");
  const [hybridPay, setHybridPay] = useState("platform");
  /** How the booking was settled for confirmation copy: paypal | in_person */
  const [confirmChannel, setConfirmChannel] = useState(null);
  const [userCoords, setUserCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const leaveNowWarnRef = useRef("");

  const selectedBarber = useMemo(() => {
    const name = form.barber?.trim();
    if (!name) return null;
    return barberOptions.find((b) => String(b.name).trim() === name) ?? null;
  }, [form.barber, barberOptions]);

  const paymentMode = selectedBarber?.paymentMode || "platform";

  function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function estimateTravelTimeMinutes(distanceKm) {
    const avgSpeed = 40; // km/h city average
    return Math.round((distanceKm / avgSpeed) * 60);
  }

  const useMyLocation = async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("Geolocation is not available on this device/browser.");
      return;
    }
    setLocating(true);
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000,
        });
      });
      const la = pos?.coords?.latitude;
      const lo = pos?.coords?.longitude;
      if (typeof la === "number" && typeof lo === "number") {
        setUserCoords({ lat: la, lng: lo });
      } else {
        setStatus("Could not read your coordinates.");
      }
    } catch (e) {
      setStatus(e?.message || "Could not get location.");
    } finally {
      setLocating(false);
    }
  };

  const showPayPal =
    paymentMode === "platform" || (paymentMode === "hybrid" && hybridPay === "platform");
  const showDirectUi =
    !selectedStyle?.styleId &&
    (paymentMode === "direct" || (paymentMode === "hybrid" && hybridPay === "direct"));

  useEffect(() => {
    const s = location.state;
    if (s?.selectedStyle?.styleId) {
      try {
        sessionStorage.setItem(STYLE_SESSION_KEY, JSON.stringify(s.selectedStyle));
      } catch {
        /* ignore */
      }
    }
  }, [location.state]);

  useEffect(() => {
    if (!selectedStyle?.styleId) return;
    setForm((prev) => ({
      ...prev,
      barber: String(selectedStyle.barberName || prev.barber),
      barberId: String(selectedStyle.barberId ?? ""),
      service: String(selectedStyle.title || prev.service),
    }));
  }, [selectedStyle]);

  useEffect(() => {
    if (selectedStyle?.styleId) return;
    const svc = searchParams.get("service");
    const bar = searchParams.get("barber");
    if (svc) {
      setForm((prev) => ({ ...prev, service: decodeURIComponent(svc) }));
    }
    if (bar) {
      setForm((prev) => ({ ...prev, barber: decodeURIComponent(bar) }));
    }
  }, [searchParams, selectedStyle?.styleId]);

  useEffect(() => {
    let c = false;
    getBarbers()
      .then((data) => {
        if (!c && Array.isArray(data) && data.length) setBarberOptions(data);
      })
      .catch(() => {
        if (!c) setBarberOptions([]);
      });
    return () => {
      c = true;
    };
  }, []);

  useEffect(() => {
    const id = String(selectedStyle?.barberId ?? form.barberId ?? "").trim();
    if (!id) {
      setBarberPricing(null);
      return;
    }
    let cancelled = false;
    fetchBarberPublicPricing(id).then((data) => {
      if (cancelled) return;
      if (data && typeof data === "object") setBarberPricing(data);
      else setBarberPricing(null);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedStyle?.barberId, form.barberId]);

  useEffect(() => {
    const bid = String(selectedStyle?.barberId ?? form.barberId ?? "").trim();
    const sid = selectedStyle?.styleId;
    if (!sid || !bid) {
      setServerQuote(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    fetchBookingQuote(bid, {
      styleId: String(sid),
      paymentType: "full",
      ...tipOpts,
    })
      .then((j) => {
        if (!cancelled) setServerQuote(j && j.ok ? j : null);
      })
      .catch(() => {
        if (!cancelled) setServerQuote(null);
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedStyle?.styleId, selectedStyle?.barberId, form.barberId, tipOpts]);

  useEffect(() => {
    if (!selectedStyle?.styleId || !barberOptions.length) return;
    let raw;
    try {
      raw = localStorage.getItem(AURA_BOOKING_FORM_PREFILL_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let hint;
    try {
      hint = JSON.parse(raw);
    } catch {
      try {
        localStorage.removeItem(AURA_BOOKING_FORM_PREFILL_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      localStorage.removeItem(AURA_BOOKING_FORM_PREFILL_KEY);
    } catch {
      /* ignore */
    }
    setForm((prev) => {
      const next = { ...prev };
      if (hint.date && typeof hint.date === "string") next.date = hint.date;
      const t = hint.selectedTime || hint.time;
      if (t && typeof t === "string" && /^\d{2}:\d{2}$/.test(t)) {
        next.time = t;
      }
      const barberHint = hint.selectedBarber || hint.barberName;
      if (barberHint && selectedStyle?.barberId != null) {
        const norm = String(barberHint).trim().toLowerCase();
        const found = barberOptions.find((b) => String(b.name || "").trim().toLowerCase() === norm);
        if (found && String(found.id) === String(selectedStyle.barberId)) {
          next.barber = String(found.name);
          next.barberId = String(found.id);
        }
      }
      return next;
    });
  }, [selectedStyle?.styleId, selectedStyle?.barberId, barberOptions]);

  useEffect(() => {
    setHybridPay("platform");
    setConfirmChannel(null);
  }, [form.barber]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleBarberChange = (e) => {
    const name = e.target.value;
    const found = barberOptions.find((b) => b.name === name);
    setForm((prev) => ({
      ...prev,
      barber: name,
      barberId: found != null && found.id != null ? String(found.id) : undefined,
    }));
  };

  const generateTimeSlots = () => {
    const slots = [];
    for (let h = 0; h < 24; h++) {
      for (const m of ["00", "30"]) {
        const hour = h.toString().padStart(2, "0");
        slots.push(`${hour}:${m}`);
      }
    }
    return slots;
  };

  const timeSlots = generateTimeSlots();

  const travelMinutes = useMemo(() => {
    if (!userCoords) return null;
    const shopLat = selectedBarber?.location?.latitude;
    const shopLng = selectedBarber?.location?.longitude;
    if (typeof shopLat !== "number" || typeof shopLng !== "number") return null;
    const km = getDistanceKm(userCoords.lat, userCoords.lng, shopLat, shopLng);
    if (!Number.isFinite(km)) return null;
    return estimateTravelTimeMinutes(km);
  }, [selectedBarber?.location?.latitude, selectedBarber?.location?.longitude, userCoords]);

  const confirmationDistanceMiles = useMemo(() => {
    if (!userCoords) return null;
    const shopLat = selectedBarber?.location?.latitude;
    const shopLng = selectedBarber?.location?.longitude;
    if (typeof shopLat !== "number" || typeof shopLng !== "number") return null;
    const km = getDistanceKm(userCoords.lat, userCoords.lng, shopLat, shopLng);
    if (!Number.isFinite(km)) return null;
    return km * 0.621371;
  }, [selectedBarber?.location?.latitude, selectedBarber?.location?.longitude, userCoords]);

  const bookingMapEmbedSrc = useMemo(
    () => mapsEmbedSrcForShop(selectedBarber?.location),
    [selectedBarber],
  );

  const canOpenBookingDirections = useMemo(
    () => canOpenDirectionsToShop(selectedBarber?.location),
    [selectedBarber],
  );

  const filteredTimeSlots = useMemo(() => {
    // Only enforce "slotTime > currentTime + travelTime" for today.
    if (!form.date || travelMinutes == null) return timeSlots;

    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;
    if (String(form.date) !== todayStr) return timeSlots;

    const now = new Date();
    const cutoff = now.getHours() * 60 + now.getMinutes() + Number(travelMinutes);

    return timeSlots.filter((t) => {
      const [hh, min] = String(t).split(":");
      const mins = Number(hh) * 60 + Number(min);
      return Number.isFinite(mins) ? mins > cutoff : true;
    });
  }, [form.date, timeSlots, travelMinutes]);

  useEffect(() => {
    if (!form.date || !form.time || travelMinutes == null) return;

    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;
    if (String(form.date) !== todayStr) return;

    const [hh, min] = String(form.time).split(":");
    const apptMins = Number(hh) * 60 + Number(min);
    if (!Number.isFinite(apptMins)) return;

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const timeUntilAppointment = apptMins - nowMins;
    if (!Number.isFinite(timeUntilAppointment)) return;

    const travelTime = Number(travelMinutes);
    if (!Number.isFinite(travelTime)) return;

    if (timeUntilAppointment < travelTime) {
      const key = `${form.date}|${form.time}|${travelTime}`;
      if (leaveNowWarnRef.current === key) return;
      leaveNowWarnRef.current = key;
      alert("Leave now to arrive on time");
      setStatus("Leave now to arrive on time.");
    }
  }, [form.date, form.time, travelMinutes]);
  const formReady = isFormReady(form);

  const apiOrigin = getApiOrigin();
  const bookUrl = `${apiOrigin}/api/book`;

  const submitDirectBooking = async () => {
    if (selectedStyle?.styleId) {
      setStatus("Style-based bookings use PayPal. Please pay with the button below.");
      return;
    }
    if (!formReady) {
      setStatus("Fill name, email, date, time, barber, and service first.");
      return;
    }
    setFlowPhase("saving");
    setStatus(null);
    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      date: form.date,
      time: form.time,
      service: form.service.trim(),
      barber: form.barber.trim(),
      price: stylePriceUsd,
      ...(form.barberId != null && form.barberId !== "" ? { barberId: String(form.barberId) } : {}),
    };
    if (paymentMode === "hybrid") {
      payload.paymentMethod = "direct";
    }
    try {
      const bookRes = await fetch(bookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await bookRes.text();
      let payloadJson = {};
      try {
        payloadJson = text ? JSON.parse(text) : {};
      } catch {
        payloadJson = {};
      }
      if (!bookRes.ok) {
        const errMsg =
          payloadJson?.message ||
          payloadJson?.error ||
          text?.slice(0, 240) ||
          `Booking failed (HTTP ${bookRes.status})`;
        setFlowPhase("error");
        setStatus(errMsg);
        return;
      }
      setPaid(true);
      setFlowPhase("success");
      const saved = payloadJson?.booking;
      const paypal =
        saved?.paymentStatus === "paid_paypal" ||
        saved?.paymentType === "platform" ||
        (saved?.paymentId != null && String(saved.paymentId).trim() !== "");
      setConfirmChannel(paypal ? "paypal" : "in_person");
      if (payloadJson.emailSent === false || payloadJson.email === "failed") {
        setStatus(
          payloadJson.emailError
            ? `Booking saved — email not sent: ${payloadJson.emailError}`
            : "Booking saved — confirmation email could not be sent."
        );
      } else {
        setStatus(null);
      }
    } catch (err) {
      console.error("[booking] direct submit:", err);
      setFlowPhase("error");
      setStatus(err?.message || "Booking failed.");
    }
  };

  if (!selectedStyle?.styleId) {
    return (
      <div className="ifcdc-booking-page">
        <h1 className="ifcdc-page-title">Book appointment</h1>
        <p className="ifcdc-page-lead">
          Choose a style first — each look has its own price. You will return here to pick your date and pay in one flow.
        </p>
        <button type="button" className="ifcdc-booking-confirm-btn" onClick={() => navigate("/styles")}>
          Browse styles
        </button>
      </div>
    );
  }

  return (
    <div className="ifcdc-booking-page">
      <h1 className="ifcdc-page-title">Book appointment</h1>
      <p className="ifcdc-page-lead">
        {paymentMode === "direct"
          ? "This barber is set to pay in person. Style-based booking still uses PayPal below."
          : paymentMode === "hybrid"
            ? "Pay with PayPal to confirm your style booking (or switch barber for pay-in-person only)."
            : "Complete the form, review your style and total, then pay with PayPal. Your booking is saved only after payment succeeds."}
      </p>

      {selectedStyle && isRenderableStyleImageUrl(selectedStyle.image_url) ? (
        <div className="ifcdc-style-preview">
          <StyleCoverImage
            bare
            styleId={selectedStyle.styleId || selectedStyle.id}
            barberId={selectedStyle.barber_id || selectedStyle.barberId}
            imageUrl={selectedStyle.image_url}
            alt={selectedStyle.title || "Style"}
            className="ifcdc-style-preview__img ifcdc-cover-fill"
            logContext="booking-preview"
          />
          <div>
            <p className="ifcdc-label" style={{ marginTop: 0 }}>
              Selected style
            </p>
            <p style={{ margin: "4px 0", fontWeight: 700, fontSize: "1.1rem" }}>{selectedStyle.title}</p>
            <p className="ifcdc-page-hint" style={{ margin: 0 }}>
              Barber: {selectedStyle.barberName || form.barber} · Full price ${breakdown.totalPrice.toFixed(2)}
            </p>
          </div>
        </div>
      ) : null}

      <label htmlFor="bk-name" className="ifcdc-label">
        Name
      </label>
      <input
        id="bk-name"
        name="name"
        placeholder="Full name"
        value={form.name}
        onChange={handleChange}
        className="ifcdc-input"
        autoComplete="name"
      />

      <label htmlFor="bk-email" className="ifcdc-label">
        Email
      </label>
      <input
        id="bk-email"
        name="email"
        type="email"
        placeholder="you@example.com"
        value={form.email}
        onChange={handleChange}
        className="ifcdc-input"
        autoComplete="email"
      />

      <label htmlFor="bk-date" className="ifcdc-label">
        Date
      </label>
      <input id="bk-date" type="date" name="date" value={form.date} onChange={handleChange} className="ifcdc-input" />

      <label htmlFor="bk-time" className="ifcdc-label">
        Time
      </label>
      <select id="bk-time" name="time" value={form.time} onChange={handleChange} className="ifcdc-input ifcdc-select">
        <option value="">Select time</option>
        {filteredTimeSlots.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <button type="button" className="ifcdc-booking-confirm-btn" onClick={useMyLocation} disabled={locating}>
          {locating ? "Locating…" : "Use My Location"}
        </button>
        {travelMinutes != null ? (
          <p className="ifcdc-page-hint" style={{ margin: 0 }}>
            Travel time est.: {travelMinutes} min · Today’s slots filtered by (now + travel).
          </p>
        ) : hasShopCoords(selectedBarber?.location) ? (
          <p className="ifcdc-page-hint" style={{ margin: 0 }}>
            Tap “Use My Location” to filter today’s slots by travel time.
          </p>
        ) : shopAddressText(selectedBarber?.location) ? (
          <p className="ifcdc-page-hint" style={{ margin: 0 }}>
            Shop address is on file — use <strong>Get directions</strong> after booking. Drive-time slot filtering only
            applies when coordinates are stored (optional).
          </p>
        ) : null}
      </div>

      <label htmlFor="bk-service" className="ifcdc-label">
        Service
      </label>
      {selectedStyle?.styleId ? (
        <input id="bk-service" className="ifcdc-input" value={form.service} readOnly aria-readonly="true" />
      ) : (
        <select
          id="bk-service"
          name="service"
          value={form.service}
          onChange={handleChange}
          className="ifcdc-input ifcdc-select"
        >
          <option value="">Select service</option>
          {SERVICE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}

      <label htmlFor="bk-barber" className="ifcdc-label">
        Barber
      </label>
      {selectedStyle?.styleId ? (
        <input id="bk-barber" className="ifcdc-input" value={form.barber} readOnly aria-readonly="true" />
      ) : (
        <select
          id="bk-barber"
          name="barber"
          value={form.barber}
          onChange={handleBarberChange}
          className="ifcdc-input ifcdc-select"
        >
          <option value="">Select barber</option>
          {barberOptions.map((b) => (
            <option key={b.id} value={b.name}>
              {b.name}
            </option>
          ))}
          {barberOptions.length === 0 ? (
            <>
              <option value="Mike">Mike</option>
              <option value="Jay">Jay</option>
            </>
          ) : null}
        </select>
      )}

      <section className="ifcdc-booking-summary" aria-labelledby="bk-summary-heading">
        <h2 id="bk-summary-heading" className="ifcdc-booking-summary__title">
          Order summary
        </h2>
        <dl className="ifcdc-booking-summary__dl">
          <div>
            <dt>Service</dt>
            <dd>{form.service || "—"}</dd>
          </div>
          <div>
            <dt>Barber</dt>
            <dd>{form.barber || "—"}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{form.date || "—"}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{form.time || "—"}</dd>
          </div>
          <div>
            <dt>Service price</dt>
            <dd className="ifcdc-booking-price">${breakdown.totalPrice.toFixed(2)} USD</dd>
          </div>
          <div>
            <dt>Tip (optional)</dt>
            <dd>{breakdown.tipAmount > 0 ? `$${breakdown.tipAmount.toFixed(2)}` : "None"}</dd>
          </div>
          <div>
            <dt>Platform fee</dt>
            <dd>${Number(breakdown.platformFee || 0).toFixed(2)} USD</dd>
          </div>
          <div>
            <dt>Total due (PayPal)</dt>
            <dd className="ifcdc-booking-price">${breakdown.paypalTotal.toFixed(2)} USD</dd>
          </div>
        </dl>
        {showPayPal ? (
          <>
            <p className="ifcdc-page-hint" style={{ marginTop: 16 }}>
              {Number(breakdown.platformFee) > 0
                ? `Full payment: $${breakdown.totalPrice.toFixed(2)} service + $${Number(breakdown.platformFee).toFixed(2)} platform fee (plus any tip).`
                : `Full payment: $${breakdown.totalPrice.toFixed(2)} for this service (plus any tip).`}
            </p>
            <p className="ifcdc-label" style={{ marginTop: 16 }}>
              Optional tip
            </p>
            <div className="ifcdc-tip-row" role="group" aria-label="Tip amount">
              {["none", "5", "10", "15", "custom"].map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`ifcdc-tip-btn${tipChoice === k ? " ifcdc-tip-btn--active" : ""}`}
                  onClick={() => {
                    setTipChoice(k);
                    setStatus(null);
                  }}
                >
                  {k === "none" ? "No tip" : k === "custom" ? "Custom" : `${k}%`}
                </button>
              ))}
            </div>
            {tipChoice === "custom" ? (
              <label className="ifcdc-label" htmlFor="bk-custom-tip">
                Custom tip (USD)
                <input
                  id="bk-custom-tip"
                  type="number"
                  min="0"
                  step="0.01"
                  className="ifcdc-input"
                  style={{ marginTop: 6 }}
                  value={customTip}
                  onChange={(e) => setCustomTip(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            ) : null}
          </>
        ) : null}
        {!formReady ? (
          <p className="ifcdc-booking-summary__hint" role="status">
            Fill all fields above to continue.
          </p>
        ) : null}
      </section>

      {paymentMode === "hybrid" ? (
        <>
          <p className="ifcdc-label">Payment</p>
          <div className="ifcdc-hybrid-pay-row" role="group" aria-label="Choose payment method">
            <button
              type="button"
              className={`ifcdc-hybrid-pay-btn${hybridPay === "platform" ? " ifcdc-hybrid-pay-btn--active" : ""}`}
              onClick={() => {
                setHybridPay("platform");
                setStatus(null);
              }}
            >
              Pay with PayPal
            </button>
            <button
              type="button"
              className={`ifcdc-hybrid-pay-btn${hybridPay === "direct" ? " ifcdc-hybrid-pay-btn--active" : ""}`}
              onClick={() => {
                setHybridPay("direct");
                setStatus(null);
              }}
            >
              Pay in Person
            </button>
          </div>
        </>
      ) : null}

      {paymentMode === "platform" || (paymentMode === "hybrid" && showPayPal) ? (
        <h3 className="ifcdc-booking-pay-heading">Pay with PayPal</h3>
      ) : null}
      {paymentMode === "direct" ? (
        <>
          <h3 className="ifcdc-booking-pay-heading">Payment</h3>
          <span className="ifcdc-pay-at-badge" role="status">
            Pay at appointment
          </span>
          <p className="ifcdc-booking-direct-msg">
            Pay your barber directly at the appointment (cash, Zelle, or as arranged).
          </p>
        </>
      ) : null}
      {paymentMode === "hybrid" && showDirectUi ? (
        <>
          <h3 className="ifcdc-booking-pay-heading">Confirm booking</h3>
          <span className="ifcdc-pay-at-badge" role="status">
            Pay at appointment
          </span>
          <p className="ifcdc-booking-direct-msg">
            Pay your barber directly at the appointment.
          </p>
        </>
      ) : null}

      {flowPhase === "capturing" ? (
        <p className="ifcdc-booking-flow-status" role="status">
          Capturing payment…
        </p>
      ) : null}
      {flowPhase === "saving" ? (
        <p className="ifcdc-booking-flow-status" role="status">
          Saving booking and sending confirmation…
        </p>
      ) : null}

      {showPayPal ? (
        <div
          className="paypal-buttons-host"
          key={`paypal-full-${chargeAmountUsd}-${tipChoice}-${customTip}`}
          id="paypal-button-container"
        >
          <BookingPayPalBlock
            form={form}
            chargeAmountUsd={chargeAmountUsd}
            paymentType={breakdown.paymentType}
            totalPriceUsd={breakdown.totalPrice}
            styleId={selectedStyle.styleId}
            barberId={String(selectedStyle.barberId ?? "")}
            tipPercent={["5", "10", "15"].includes(tipChoice) ? Number(tipChoice) : 0}
            tipAmount={tipChoice === "custom" && Number(customTip) > 0 ? Number(customTip) : 0}
            setPaid={setPaid}
            setStatus={setStatus}
            setFlowPhase={setFlowPhase}
            bookBodyExtra={paymentMode === "hybrid" ? { paymentMethod: "platform" } : {}}
            onBookingSaved={(booking) => {
              setSavedBookingSnapshot(booking || null);
              if (!booking) return;
              const paypal =
                booking.paymentStatus === "paid_in_full" ||
                booking.paymentStatus === "paid_paypal" ||
                booking.paymentType === "platform" ||
                (booking.paymentId != null && String(booking.paymentId).trim() !== "");
              setConfirmChannel(paypal ? "paypal" : "in_person");
            }}
          />
        </div>
      ) : null}

      {showDirectUi ? (
        <div className="ifcdc-booking-direct-actions">
          <button
            type="button"
            className="ifcdc-booking-confirm-btn"
            disabled={!formReady || flowPhase === "saving"}
            onClick={submitDirectBooking}
          >
            {flowPhase === "saving" ? "Saving…" : "Confirm booking"}
          </button>
        </div>
      ) : null}

      {paid && flowPhase === "success" ? (
        <div className="booking-confirmation" role="status">
          <h2>{"You're Booked"}</h2>
          <p className="booking-confirmation__status">
            {confirmChannel === "paypal"
              ? "Payment successful — booking confirmed. Check your email for IFCDC confirmation."
              : "Booking confirmed."}
          </p>
          <div className="details">
            <p>Barber: {form.barber || "—"}</p>
            <p>Time: {formatAppointmentDisplay(form.date, form.time)}</p>
            <p>
              Distance:{" "}
              {confirmationDistanceMiles != null
                ? `${confirmationDistanceMiles.toFixed(1)} miles`
                : userCoords
                  ? "Add shop coordinates for this barber to see distance."
                  : "Use My Location above to see distance (when the shop has coordinates)."}
            </p>
            <p>
              Payment:{" "}
              {confirmChannel === "paypal"
                ? (() => {
                    let t = "Paid in full via PayPal";
                    const tip = Number(savedBookingSnapshot?.tipAmount ?? 0);
                    if (tip > 0) {
                      t += ` · Tip $${tip.toFixed(2)} · Charged $${Number(savedBookingSnapshot?.totalPaid ?? 0).toFixed(2)}`;
                    }
                    return t;
                  })()
                : "Pay in person"}
            </p>
          </div>
          {bookingMapEmbedSrc ? (
            <div className="booking-confirmation__map-wrap">
              <iframe
                width="100%"
                height="200"
                className="booking-confirmation__map"
                style={{ border: 0, display: "block" }}
                loading="lazy"
                allowFullScreen
                title={`Shop location for ${form.barber || "your barber"}`}
                src={bookingMapEmbedSrc}
              />
            </div>
          ) : null}
          {canOpenBookingDirections ? (
            <button
              type="button"
              className="ifcdc-booking-confirm-btn booking-confirmation__directions"
              onClick={() => openDirectionsToShop(selectedBarber?.location)}
            >
              Get Directions
            </button>
          ) : null}
        </div>
      ) : null}

      {status ? (
        <p className={`ifcdc-error-msg${paid ? " ifcdc-msg--soft" : ""}`} role="alert">
          {status}
        </p>
      ) : null}
    </div>
  );
}
