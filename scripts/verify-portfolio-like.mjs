#!/usr/bin/env node
/**
 * Verify portfolio style-gallery like API (svc-* / gal-* ids).
 * Usage: node scripts/verify-portfolio-like.mjs [--base URL] [--token JWT]
 */
const base = (() => {
  const i = process.argv.indexOf("--base");
  return (i >= 0 ? process.argv[i + 1] : process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(
    /\/$/,
    "",
  );
})();
const tokenArg = (() => {
  const i = process.argv.indexOf("--token");
  return i >= 0 ? process.argv[i + 1] : process.env.QA_TOKEN || "";
})();

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`OK: ${msg}`);
}

async function req(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* ignore */
  }
  return { res, json, text };
}

console.log(`\nPortfolio like verification → ${base}\n`);

const discover = await req("/api/portfolio/discover?limit=20");
if (!discover.res.ok || !discover.json.ok) fail("discover feed unavailable");
const photo =
  (discover.json.photos || []).find((p) => String(p.id || "").startsWith("svc-") || String(p.id || "").startsWith("gal-")) ||
  null;
if (!photo) fail("no svc-/gal- photo in discover feed");
ok(`sample photo id=${photo.id}`);

const unauth = await req(`/api/photos/${encodeURIComponent(photo.id)}/like`, { method: "POST" });
if (unauth.res.status !== 401) fail(`unauthenticated like should 401, got ${unauth.res.status}`);
ok("unauthenticated like returns 401");

if (!tokenArg) {
  console.log("\nSkip authenticated toggle (pass --token or QA_TOKEN).\n");
  process.exit(0);
}

const first = await req(`/api/photos/${encodeURIComponent(photo.id)}/like`, { method: "POST", token: tokenArg });
if (!first.res.ok || !first.json.ok) {
  fail(`like failed: ${first.json.message || first.text.slice(0, 120)}`);
}
if (typeof first.json.liked !== "boolean") fail("like response missing liked");
if (typeof first.json.likeCount !== "number") fail("like response missing likeCount");
ok(`like toggle #1 liked=${first.json.liked} count=${first.json.likeCount}`);

const second = await req(`/api/photos/${encodeURIComponent(photo.id)}/like`, { method: "POST", token: tokenArg });
if (!second.res.ok || !second.json.ok) fail(`unlike failed: ${second.json.message || second.text}`);
if (second.json.liked === first.json.liked) fail("second toggle did not flip liked state");
ok(`like toggle #2 liked=${second.json.liked} count=${second.json.likeCount}`);

console.log("\nAll portfolio like checks passed.\n");
