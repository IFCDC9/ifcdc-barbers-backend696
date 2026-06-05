#!/usr/bin/env node
const ORIGINS = [
  { name: "ifcdcbarbersapp.com", url: "https://ifcdcbarbersapp.com" },
  { name: "www.ifcdcbarbersapp.com", url: "https://www.ifcdcbarbersapp.com" },
  { name: "ifcdc.org", url: "https://ifcdc.org" },
  { name: "ifcdcbarbersapp.org", url: "https://ifcdcbarbersapp.org" },
  { name: "Render frontend (official SPA)", url: "https://ifcdc-barbers-frontend.onrender.com" },
];

let failed = 0;
console.log("\nPublic domain verification\n");

for (const { name, url } of ORIGINS) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const html = await res.text();
    const godaddy = /lander|godaddy|parked/i.test(html) || html.length < 200;
    const ifcdc = /IFCDC Barbers|ifcdc-barbers/i.test(html);
    if (godaddy && !ifcdc) {
      console.log(`WARN ${name} → GoDaddy/parking or placeholder (${html.length} bytes)`);
      if (name.includes("ifcdcbarbersapp.com") || name === "ifcdc.org") failed++;
    } else if (ifcdc) {
      console.log(`OK   ${name} → IFCDC SPA (${res.status})`);
    } else {
      console.log(`?    ${name} → HTTP ${res.status}, ${html.length} bytes`);
    }
  } catch (e) {
    console.log(`FAIL ${name} → ${e.message}`);
    failed++;
  }
}

if (failed) {
  console.log("\nFix GoDaddy DNS per docs/DOMAIN_DNS_FIX.md\n");
  process.exit(1);
}
console.log("\nCustom domains OK (or only Render URL required).\n");
