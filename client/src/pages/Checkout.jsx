import React from "react";
import { Page, PageHeader } from "../components/ui/Page.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Button } from "../components/ui/Button.jsx";
import { theme } from "../components/ui/theme.js";
import { safeApiGet } from "../lib/api.js";
import { SAFE_FALLBACK_SLOTS } from "../lib/safeSlots.js";
import PayPalCheckout from "../components/PayPalCheckout.jsx";

/**
 * Checkout: order summary + PayPal (Smart Buttons via PayPalScriptProvider in main.jsx).
 */
export default function Checkout({
  navigate,
  barberName = "",
  serviceName = "",
  servicePrice = 20,
  durationMinutes = null,
  date = "",
  time = "",
}) {
  const payAmount = React.useMemo(() => {
    const n = Number(servicePrice);
    const v = Number.isFinite(n) && n > 0 ? n : 20;
    return Math.min(9999, v).toFixed(2);
  }, [servicePrice]);

  const [availableTimes, setAvailableTimes] = React.useState([]);
  const [nextAvailable, setNextAvailable] = React.useState("—");
  const [slotsLoading, setSlotsLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!barberName || !date) {
          if (!cancelled) {
            setAvailableTimes([]);
            setNextAvailable("—");
          }
          return;
        }
        setSlotsLoading(true);
        const q = new URLSearchParams({ date, barber: barberName }).toString();
        const data = await safeApiGet(`/api/availability?${q}`);
        console.log("AVAILABILITY RESPONSE:", data);
        let slots = [];
        if (data == null) {
          slots = [...SAFE_FALLBACK_SLOTS];
        } else {
          const avail = Array.isArray(data) ? data : (data?.availableTimes ?? []);
          slots = avail?.length ? [...avail] : [];
          if (!slots.length) slots = [...SAFE_FALLBACK_SLOTS];
        }
        const next =
          data?.nextAvailable != null && data?.nextAvailable !== ""
            ? String(data.nextAvailable)
            : (slots[0] ?? "—");
        if (!cancelled) {
          setAvailableTimes(slots);
          setNextAvailable(next && next !== "null" ? next : "—");
        }
      } catch (e) {
        console.warn("[ifcdc] availability unexpected error, using safe fallback slots:", e);
        if (!cancelled) {
          setAvailableTimes([...SAFE_FALLBACK_SLOTS]);
          setNextAvailable(SAFE_FALLBACK_SLOTS[0]);
        }
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [barberName, date]);

  const backToBooking = () => {
    const q = new URLSearchParams({
      barber: barberName,
      service: serviceName,
      price: String(servicePrice),
      ...(durationMinutes != null && Number(durationMinutes) > 0 ? { duration: String(durationMinutes) } : {}),
    });
    navigate?.(`/booking?${q.toString()}`);
  };

  const hasSlot = Boolean(barberName) && Boolean(date) && Boolean(time);
  const bookingContext = hasSlot
    ? {
        barberName,
        date,
        time,
        serviceName,
        payAmount,
        durationMinutes,
      }
    : null;

  return (
    <Page>
      <section>
        <PageHeader
          title="Checkout / Payment"
          subtitle={
            <>
              {hasSlot
                ? "Confirm details, then pay — you’ll see confirmation after a successful payment."
                : "Add barber, date, and time from booking for a full reservation — PayPal is available below."}
            </>
          }
        />

        <div style={styles.flowBanner}>
          <span style={styles.flowStepDone}>1. Date &amp; time</span>
          <span style={styles.flowArrow}>→</span>
          <span style={styles.flowStepActive}>2. Pay</span>
          <span style={styles.flowArrow}>→</span>
          <span style={styles.flowStep}>3. Confirmation</span>
        </div>

        {slotsLoading ? <div style={styles.muted}>Checking slot availability…</div> : null}

        <div style={{ marginTop: 16, maxWidth: 560 }}>
          <Card>
            <div style={styles.sectionTitle}>Order summary</div>
            <div style={styles.summaryGrid}>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Barber</span>
                <span style={styles.summaryValue}>{barberName || "—"}</span>
              </div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Service</span>
                <span style={styles.summaryValue}>{serviceName || "Standard service"}</span>
              </div>
              {durationMinutes != null && Number(durationMinutes) > 0 ? (
                <div style={styles.summaryRow}>
                  <span style={styles.summaryLabel}>Duration</span>
                  <span style={styles.summaryValue}>{durationMinutes} min</span>
                </div>
              ) : null}
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Date</span>
                <span style={styles.summaryValue}>{date || "—"}</span>
              </div>
              <div style={styles.summaryRow}>
                <span style={styles.summaryLabel}>Time</span>
                <span style={styles.summaryValue}>{time || "—"}</span>
              </div>
              <div style={{ ...styles.summaryRow, borderTop: `1px solid ${theme.colors.border}`, paddingTop: 12, marginTop: 4 }}>
                <span style={styles.summaryTotal}>Total due</span>
                <span style={styles.summaryTotalAmt}>${payAmount} USD</span>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <Button variant="indigo" type="button" onClick={backToBooking} style={{ width: "auto", minWidth: 200 }}>
                ← Edit booking
              </Button>
            </div>
          </Card>

          <p style={styles.muted}>
            PayPal checkout runs on the Booking page so your payment includes the $0.99 platform fee and triggers
            your IFCDC confirmation email after capture.
          </p>
          <PayPalCheckout
            amount={payAmount}
            navigate={navigate}
            bookingContext={bookingContext}
          />
        </div>
      </section>
    </Page>
  );
}

const styles = {
  flowBanner: {
    marginTop: 14,
    maxWidth: 560,
    padding: "12px 14px",
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: "rgba(0,0,0,0.22)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: theme.colors.muted,
    fontWeight: 700,
  },
  flowStep: { color: theme.colors.muted },
  flowStepDone: { color: theme.colors.text },
  flowStepActive: { color: theme.colors.accent, fontWeight: 900 },
  flowArrow: { opacity: 0.45 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 900,
    color: theme.colors.text,
    marginBottom: 12,
  },
  summaryGrid: {
    display: "grid",
    gap: 10,
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 16,
    flexWrap: "wrap",
  },
  summaryLabel: {
    fontSize: 13,
    color: theme.colors.muted,
    fontWeight: 700,
  },
  summaryValue: {
    fontSize: 14,
    color: theme.colors.text,
    fontWeight: 800,
    textAlign: "right",
  },
  summaryTotal: {
    fontSize: 14,
    color: theme.colors.text,
    fontWeight: 900,
  },
  summaryTotalAmt: {
    fontSize: 18,
    color: theme.colors.accent,
    fontWeight: 900,
  },
  muted: {
    color: theme.colors.muted,
    fontSize: 14,
    lineHeight: 1.5,
  },
};
