#!/usr/bin/env node
/**
 * Static audit: mobile + web must share backend696 payment/book/email paths.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

const checks = [
  {
    name: "mobile finalize trusts server paymentCaptured",
    file: "mobile/services/bookingPayPalApi.js",
    ok: () => {
      const s = read("mobile/services/bookingPayPalApi.js");
      return s.includes("paymentCaptured") && s.includes("FINALIZE_RETRY_ATTEMPTS");
    },
  },
  {
    name: "web Booking uses create-order → capture → /api/book",
    file: "client/src/pages/Booking.jsx",
    ok: () => {
      const s = read("client/src/pages/Booking.jsx");
      return s.includes("/api/paypal") && s.includes("/api/book");
    },
  },
  {
    name: "PayPalCheckout does not call /api/bookings/confirm",
    file: "client/src/components/PayPalCheckout.jsx",
    ok: () => !read("client/src/components/PayPalCheckout.jsx").includes("/api/bookings/confirm"),
  },
  {
    name: "app-bookings start requires deliverable email",
    file: "appBookingCheckoutRoutes.cjs",
    ok: () => {
      const s = read("appBookingCheckoutRoutes.cjs");
      return s.includes("customer_email_required") && s.includes("isDeliverableCustomerEmail");
    },
  },
  {
    name: "POST /api/book validates deliverable email",
    file: "bookingsRoutes.js",
    ok: () => {
      const s = read("bookingsRoutes.js");
      return s.includes("invalid_email") && s.includes("isDeliverableCustomerEmail(customerEmail)");
    },
  },
  {
    name: "app finalize returns emailSent",
    file: "appBookingCheckoutRoutes.cjs",
    ok: () => read("appBookingCheckoutRoutes.cjs").includes("emailSent,"),
  },
  {
    name: "PayPal already-captured fallback",
    file: "paypalOrderCaptureHelpers.cjs",
    ok: () => read("paypalOrderCaptureHelpers.cjs").includes("captureOrGetCompletedPayPalOrder"),
  },
  {
    name: "orphaned payment admin alert",
    file: "orphanedPaymentAlert.cjs",
    ok: () => read("orphanedPaymentAlert.cjs").includes("sendOrphanedPaymentAdminAlert"),
  },
];

let failed = 0;
for (const c of checks) {
  if (c.ok()) {
    console.log(`OK  ${c.name}`);
  } else {
    console.error(`FAIL ${c.name} (${c.file})`);
    failed++;
  }
}

if (failed) process.exit(1);
console.log("\nE2E payment audit (static): all checks passed.");
