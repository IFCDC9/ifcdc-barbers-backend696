import React from "react";
import { Card } from "./ui/Card.jsx";
import { Button } from "./ui/Button.jsx";
import { theme } from "./ui/theme.js";

/**
 * Legacy checkout surface — PayPal + booking must use /booking (server totals + POST /api/book + email).
 * This component no longer runs legacy client-side PayPal or in-memory booking confirm routes.
 */
export default function PayPalCheckout({
  navigate,
  bookingContext = null,
  amount,
}) {
  const goToBooking = () => {
    const ctx = bookingContext;
    const q = new URLSearchParams();
    if (ctx?.barberName) q.set("barber", ctx.barberName);
    if (ctx?.serviceName) q.set("service", ctx.serviceName);
    if (ctx?.date) q.set("date", ctx.date);
    if (ctx?.time) q.set("time", ctx.time);
    navigate?.(`/booking?${q.toString()}`);
  };

  const amt = Number(amount);
  const displayAmt = Number.isFinite(amt) && amt > 0 ? amt.toFixed(2) : null;

  return (
    <Card style={{ marginTop: 14 }}>
      <div style={st.sectionTitle}>Complete payment on Booking</div>
      <p style={st.mutedSmall}>
        IFCDC requires full payment (service price + $0.99 platform fee) through our secure booking page.
        PayPal is charged server-side and your booking confirmation email is sent only after capture is verified.
      </p>
      {displayAmt ? (
        <p style={st.mutedSmall}>
          Estimated service price shown here: ${displayAmt} — final total includes the $0.99 platform fee on the
          booking page.
        </p>
      ) : null}
      <Button variant="indigo" type="button" onClick={goToBooking} style={{ marginTop: 12, width: "100%" }}>
        Continue to Book &amp; Pay
      </Button>
    </Card>
  );
}

const st = {
  sectionTitle: {
    fontSize: 15,
    fontWeight: 900,
    color: theme.colors.text,
    marginBottom: 12,
  },
  mutedSmall: {
    color: theme.colors.muted,
    fontSize: 12,
    marginBottom: 10,
    lineHeight: 1.45,
  },
};
