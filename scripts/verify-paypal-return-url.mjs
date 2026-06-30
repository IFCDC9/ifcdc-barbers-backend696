#!/usr/bin/env node
/**
 * Verify PayPal LIVE return URL coercion (custom scheme → https SPA bridge).
 * Run: node scripts/verify-paypal-return-url.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildMobilePayPalReturnUrl,
  resolvePayPalCheckoutReturnUrls,
} = require("../publicSiteConfig.cjs");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  } else {
    console.log("OK:", msg);
  }
}

const httpsReturn = buildMobilePayPalReturnUrl();
assert(httpsReturn.startsWith("https://"), `canonical return is https: ${httpsReturn}`);
assert(httpsReturn.endsWith("/paypal-booking"), `canonical path: ${httpsReturn}`);

const coerced = resolvePayPalCheckoutReturnUrls("ifcdc-barbers://paypal-booking/", null);
assert(coerced.coerced === true, "custom scheme is coerced");
assert(coerced.returnUrl === httpsReturn, "coerced return matches canonical");
assert(coerced.cancelUrl === httpsReturn, "coerced cancel matches canonical");

const kept = resolvePayPalCheckoutReturnUrls("https://ifcdcbarbersapp.com/booking", null);
assert(kept.coerced === false, "https booking URL kept");
assert(kept.returnUrl === "https://ifcdcbarbersapp.com/booking", "https return unchanged");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll PayPal return URL checks passed");
process.exit(failed ? 1 : 0);
