#!/usr/bin/env node
/**
 * Capture App Store screenshots from production SPA (synced with Build 35 API).
 * Outputs fastlane-compatible folders for iPhone 6.5" and iPad 13".
 *
 * Usage: node scripts/capture-asc-screenshots.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "mobile", "fastlane", "screenshots", "en-US");
const BASE = "https://ifcdcbarbersapp.com";

/** Apple App Store Connect required pixel sizes */
const TARGET = {
  iphone65: { width: 1284, height: 2778, device: "iPhone 16 Plus" },
  ipad13: { width: 2064, height: 2752, device: "iPad Pro 13-inch (M4)" },
};

const SHOTS = [
  { file: "01_Home", path: "/" },
  { file: "02_Barbers", path: "/booking", setup: "barbers" },
  { file: "03_Booking", path: "/booking", setup: "datetime" },
  { file: "04_Services_Styles", path: "/styles" },
  { file: "05_Profile", path: "/profile" },
  { file: "06_AURA", path: "/aura" },
];

async function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function resizeToExact(buffer, width, height) {
  return sharp(buffer)
    .resize(width, height, { fit: "contain", background: { r: 5, g: 5, b: 8 } })
    .png()
    .toBuffer();
}

async function setupBooking(page, mode) {
  await page.goto(`${BASE}/booking`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  if (mode === "barbers") return;

  const barberBtn = page.locator(".ifcdc-book-wizard__barber, .ifcdc-book-wizard__service, button").filter({ hasText: /IFCDC|Barber|Chris/i }).first();
  if (await barberBtn.count()) {
    await barberBtn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const next = page.getByRole("button", { name: /continue|next/i }).first();
  if (await next.count()) {
    await next.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  if (mode === "services") return;

  const serviceBtn = page.locator(".ifcdc-book-wizard__service").first();
  if (await serviceBtn.count()) {
    await serviceBtn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const next2 = page.getByRole("button", { name: /continue|next/i }).first();
  if (await next2.count()) {
    await next2.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const dateBtn = page.locator(".ifcdc-book-wizard__date button, button").filter({ hasText: /Today|Tomorrow|Mon|Tue|Wed/i }).first();
  if (await dateBtn.count()) {
    await dateBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
}

async function captureSet(browser, profile, targetKey) {
  const spec = TARGET[targetKey];
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "en-US",
    viewport: profile.viewport || { width: 390, height: 844 },
    deviceScaleFactor: profile.deviceScaleFactor ?? 3,
    isMobile: profile.isMobile ?? true,
    hasTouch: profile.hasTouch ?? true,
    userAgent: profile.userAgent,
  });
  const page = await context.newPage();

  for (const shot of SHOTS) {
    if (shot.setup?.startsWith("barber") || shot.setup === "datetime") {
      await setupBooking(page, shot.setup === "datetime" ? "datetime" : "barbers");
    } else {
      await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(2000);
    }

    const raw = await page.screenshot({ fullPage: false, type: "png" });
    const png = await resizeToExact(raw, spec.width, spec.height);
    const name = `${spec.device}-${shot.file}.png`;
    const outPath = path.join(OUT, name);
    fs.writeFileSync(outPath, png);
    console.log(`✓ ${targetKey}: ${name} (${spec.width}x${spec.height})`);
  }

  await context.close();
}

async function main() {
  await ensureDir(OUT);

  const browser = await chromium.launch({ headless: true });

  const profiles = {
    iphone65: devices["iPhone 16 Plus"] || {
      viewport: { width: 430, height: 932 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: devices["iPhone 16 Plus"]?.userAgent,
    },
    ipad13: devices["iPad Pro 13-inch (M4)"] ||
      devices["iPad Pro 12.9-inch (6th generation)"] || {
        viewport: { width: 1032, height: 1376 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
  };

  await captureSet(browser, profiles.iphone65, "iphone65");
  await captureSet(browser, profiles.ipad13, "ipad13");

  await browser.close();

  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".png"));
  console.log(`\nCaptured ${files.length} screenshots → ${OUT}`);
  for (const f of files.sort()) console.log(`  ${f}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
