#!/usr/bin/env node
/**
 * Verify IFCDC Barbers public domains serve the React SPA (not GoDaddy parking).
 * ifcdc.org is informational only — warn, do not fail the build.
 */
const BARBERS_ORIGINS = [
  { name: "ifcdcbarbersapp.com", url: "https://ifcdcbarbersapp.com", required: true },
  { name: "www.ifcdcbarbersapp.com", url: "https://www.ifcdcbarbersapp.com", required: true },
  { name: "Render frontend (official SPA)", url: "https://ifcdc-barbers-frontend.onrender.com", required: true },
];

const OPTIONAL_ORIGINS = [
  { name: "ifcdc.org (org site — not barbers SPA)", url: "https://ifcdc.org" },
  { name: "ifcdcbarbersapp.org (unused)", url: "https://ifcdcbarbersapp.org" },
];

function analyzeHtml(html) {
  const godaddy = /lander|godaddy|parked|wsimg\.com\/parking/i.test(html) || html.length < 200;
  const ifcdc = /IFCDC Barbers|ifcdc-barbers|id="root"/i.test(html);
  return { godaddy, ifcdc };
}

let failed = 0;
console.log("\nPublic domain verification (IFCDC Barbers)\n");

for (const { name, url, required } of BARBERS_ORIGINS) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const html = await res.text();
    const { godaddy, ifcdc } = analyzeHtml(html);
    if (godaddy && !ifcdc) {
      console.log(`FAIL ${name} → GoDaddy/parking or placeholder (${html.length} bytes)`);
      if (required) failed++;
    } else if (ifcdc) {
      console.log(`OK   ${name} → IFCDC SPA (${res.status})`);
    } else {
      console.log(`WARN ${name} → HTTP ${res.status}, ${html.length} bytes (unexpected body)`);
      if (required) failed++;
    }
  } catch (e) {
    console.log(`FAIL ${name} → ${e.message}`);
    if (required) failed++;
  }
}

for (const { name, url } of OPTIONAL_ORIGINS) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const html = await res.text();
    const { godaddy, ifcdc } = analyzeHtml(html);
    if (ifcdc) {
      console.log(`OK   ${name} → SPA (${res.status})`);
    } else if (godaddy) {
      console.log(`WARN ${name} → parked/placeholder (not required for barbers app)`);
    } else {
      console.log(`INFO ${name} → HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`WARN ${name} → ${e.message}`);
  }
}

if (failed) {
  console.log("\nFix barbers app DNS per docs/DOMAIN_DNS_FIX.md\n");
  process.exit(1);
}
console.log("\nBarbers app domains OK.\n");
