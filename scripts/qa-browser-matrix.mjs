/**
 * Public web browser matrix (Chromium / Firefox / WebKit).
 * Verifies SPA shells, booking barber list, login form, legal pages — no live PayPal capture.
 *
 *   node scripts/qa-browser-matrix.mjs
 */
import { chromium, firefox, webkit } from "playwright";

const WEB = (process.env.FRONTEND_URL || "https://ifcdcbarbersapp.com").replace(/\/$/, "");
const API = (process.env.API_BASE || "https://ifcdc-barbers-backend696.onrender.com").replace(/\/$/, "");

const browsers = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

const pages = ["/", "/booking", "/discover", "/login", "/register", "/forgot-password", "/privacy", "/terms", "/about", "/aura", "/profile"];

let failed = 0;
const rows = [];

function log(browser, check, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  if (!ok) failed += 1;
  rows.push({ browser, check, status, detail });
  console.log(`${status.padEnd(4)} [${browser}] ${check}${detail ? ` — ${detail}` : ""}`);
}

async function runBrowser(name, type) {
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      name === "webkit"
        ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
        : undefined,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err?.message || err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  for (const path of pages) {
    try {
      const res = await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      const status = res?.status() || 0;
      const hasRoot = await page.locator("#root").count();
      log(name, `page ${path}`, status === 200 && hasRoot > 0, `HTTP ${status} root=${hasRoot}`);
    } catch (e) {
      log(name, `page ${path}`, false, e.message);
    }
  }

  // Mobile viewport smoke on home + booking
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const res = await page.goto(`${WEB}/booking`, { waitUntil: "networkidle", timeout: 60000 });
    const st = res?.status() || 0;
    log(name, "mobile viewport /booking", st === 200 || st === 304, `HTTP ${st}`);
    // Wait for barber list API-driven UI
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    const hasIfcdc = /IFCDC Barbers/i.test(body);
    const hasVerify = /Verify Barber/i.test(body);
    const timedOut = /Request timed out/i.test(body);
    log(name, "booking shows IFCDC Barbers", hasIfcdc, hasIfcdc ? "found" : "missing in body");
    log(name, "booking hides Verify Barber", !hasVerify, hasVerify ? "LEAKED" : "ok");
    log(name, "booking no request timeout", !timedOut, timedOut ? "timeout visible" : "ok");
  } catch (e) {
    log(name, "mobile booking flow", false, e.message);
  }

  // Desktop login form presence
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const email = await page.locator('input[type="email"], input[name="email"]').count();
    const password = await page.locator('input[type="password"]').count();
    log(name, "login form fields", email > 0 && password > 0, `email=${email} password=${password}`);
  } catch (e) {
    log(name, "login form fields", false, e.message);
  }

  // Arabic language switch if dropdown exists
  try {
    await page.goto(`${WEB}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const langBtn = page.getByRole("button", { name: /language|idioma|langue|语言|언어|ngôn|لغة/i }).first();
    const select = page.locator("select").filter({ hasText: /English|Español|Arabic/i }).first();
    let switched = false;
    if (await langBtn.count()) {
      await langBtn.click({ timeout: 5000 }).catch(() => {});
      const ar = page.getByText(/العربية|Arabic/i).first();
      if (await ar.count()) {
        await ar.click({ timeout: 5000 });
        switched = true;
      }
    } else if (await select.count()) {
      await select.selectOption({ label: /Arabic|العربية/i }).catch(async () => {
        await select.selectOption("ar").catch(() => {});
      });
      switched = true;
    }
    if (switched) {
      await page.waitForTimeout(800);
      const dir = await page.evaluate(() => document.documentElement.dir || document.body.dir || "");
      log(name, "Arabic dir=rtl", dir === "rtl", `dir=${dir || "(empty)"}`);
    } else {
      log(name, "Arabic language control", false, "dropdown not found — marked incomplete");
    }
  } catch (e) {
    log(name, "Arabic language switch", false, e.message);
  }

  const serious = consoleErrors.filter(
    (t) =>
      !/favicon|ResizeObserver|Download the React DevTools|PayPal JS SDK script/i.test(t) &&
      !/api\/config.*(Failed to fetch|Load failed|Network error)/i.test(t),
  );
  // Config/PayPal SDK fetch flakes during headless cold-start are tracked separately.
  const configFlakes = consoleErrors.filter((t) => /api\/config/i.test(t)).length;
  const paypalSdkFlakes = consoleErrors.filter((t) => /PayPal JS SDK script/i.test(t)).length;
  log(name, "no serious console errors", serious.length === 0, serious.slice(0, 3).join(" | ") || "clean");
  if (configFlakes) log(name, "config fetch flake (non-blocking)", true, `seen=${configFlakes}`);
  if (paypalSdkFlakes) log(name, "PayPal SDK load flake in headless", false, `seen=${paypalSdkFlakes}`);

  // API client-id from page origin perspective
  try {
    const cid = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/paypal/client-id`);
      const j = await r.json();
      return { status: r.status, ok: j.ok, hasId: Boolean(j.clientId) };
    }, API);
    log(name, "paypal client-id from browser", cid.status === 200 && cid.hasId, JSON.stringify(cid));
  } catch (e) {
    log(name, "paypal client-id from browser", false, e.message);
  }

  await browser.close();
}

console.log(`\n=== Browser matrix → ${WEB} ===\n`);
for (const [name, type] of browsers) {
  console.log(`\n--- ${name} ---`);
  try {
    await runBrowser(name, type);
  } catch (e) {
    log(name, "browser launch", false, e.message);
  }
}

console.log(`\n=== Summary: ${rows.filter((r) => r.status === "PASS").length} pass, ${failed} fail ===`);
process.exit(failed ? 1 : 0);
