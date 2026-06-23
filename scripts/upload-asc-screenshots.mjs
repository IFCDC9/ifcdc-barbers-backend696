#!/usr/bin/env node
/**
 * Upload fastlane screenshots to App Store Connect via API (no Apple ID 2FA).
 *
 * Requires:
 *   APP_STORE_CONNECT_ISSUER_ID
 *   APP_STORE_CONNECT_KEY_ID  (e.g. AT957SKG93)
 *   APP_STORE_CONNECT_PRIVATE_KEY_PATH  (AuthKey_*.p8)
 *
 * Usage: node scripts/upload-asc-screenshots.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SHOTS_DIR = path.join(ROOT, "mobile", "fastlane", "screenshots", "en-US");
const ASC_APP_ID = "6766149605";

const DISPLAY_TYPES = {
  "iPhone 16 Plus": "APP_IPHONE_65",
  "iPhone 14 Plus": "APP_IPHONE_65",
  "iPad Pro 13-inch (M4)": "APP_IPAD_PRO_129",
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...loadEnvFile(path.join(ROOT, ".env")),
  ...loadEnvFile(path.join(ROOT, "backend", ".env")),
  ...process.env,
};

const issuerId = env.APP_STORE_CONNECT_ISSUER_ID || env.ASC_ISSUER_ID;
const keyId = env.APP_STORE_CONNECT_KEY_ID || env.ASC_KEY_ID || "AT957SKG93";
const keyPath = env.APP_STORE_CONNECT_PRIVATE_KEY_PATH || env.ASC_KEY_PATH;

if (!issuerId || !keyPath) {
  console.error(
    "Set APP_STORE_CONNECT_ISSUER_ID and APP_STORE_CONNECT_PRIVATE_KEY_PATH (AuthKey .p8 from App Store Connect → Users and Access → Keys).",
  );
  console.error(`Screenshots are ready in: ${SHOTS_DIR}`);
  process.exit(1);
}

const privateKey = fs.readFileSync(path.resolve(keyPath), "utf8");

function jwt() {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("SHA256");
  sign.update(data);
  sign.end();
  return `${data}.${sign.sign(privateKey).toString("base64url")}`;
}

async function asc(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data?.errors?.[0]?.detail || data?.errors?.[0]?.title || text.slice(0, 400));
  }
  return data;
}

async function uploadBinary(uploadOperations, filePath) {
  const op = uploadOperations?.[0];
  if (!op?.url) throw new Error("No upload operation URL");
  const buf = fs.readFileSync(filePath);
  const headers = {};
  for (const h of op.requestHeaders || []) {
    headers[h.name] = h.value;
  }
  const res = await fetch(op.url, { method: op.method || "PUT", headers, body: buf });
  if (!res.ok) throw new Error(`Upload failed ${res.status}`);
}

async function main() {
  const versions = await asc(
    `/v1/apps/${ASC_APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`,
  );
  const version = (versions.data || []).find((v) => v.attributes?.versionString === "1.0") || versions.data?.[0];
  if (!version?.id) throw new Error("No iOS app store version 1.0 found");

  const locs = await asc(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  const loc = (locs.data || []).find((l) => l.attributes?.locale === "en-US") || locs.data?.[0];
  if (!loc?.id) throw new Error("No en-US localization");

  const files = fs.readdirSync(SHOTS_DIR).filter((f) => f.endsWith(".png"));
  const byDevice = new Map();
  for (const f of files) {
    const device = Object.keys(DISPLAY_TYPES).find((d) => f.startsWith(`${d}-`));
    if (!device) continue;
    if (!byDevice.has(device)) byDevice.set(device, []);
    byDevice.get(device).push(f);
  }

  for (const [device, list] of byDevice) {
    const displayType = DISPLAY_TYPES[device];
    if (!displayType) continue;
    list.sort();

    const setRes = await asc("/v1/appScreenshotSets", {
      method: "POST",
      body: {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: "appStoreVersionLocalizations", id: loc.id },
            },
          },
        },
      },
    });
    const setId = setRes.data?.id;
    console.log(`[asc] Screenshot set ${displayType} (${device}) → ${setId}`);

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const filePath = path.join(SHOTS_DIR, file);
      const fileName = path.basename(file);
      const size = fs.statSync(filePath).size;

      const meta = await sharpMeta(filePath);
      const reserved = await asc("/v1/appScreenshots", {
        method: "POST",
        body: {
          data: {
            type: "appScreenshots",
            attributes: {
              fileName,
              fileSize: size,
            },
            relationships: {
              appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
            },
          },
        },
      });

      const shotId = reserved.data?.id;
      const ops = reserved.data?.attributes?.uploadOperations;
      await uploadBinary(ops, filePath);

      await asc(`/v1/appScreenshots/${shotId}`, {
        method: "PATCH",
        body: {
          data: {
            type: "appScreenshots",
            id: shotId,
            attributes: {
              uploaded: true,
              sourceFileChecksum: reserved.data?.attributes?.sourceFileChecksum,
            },
          },
        },
      });
      console.log(`  ✓ uploaded ${fileName} (${meta.width}x${meta.height})`);
    }
  }

  console.log("\n[asc] Screenshot upload complete.");
}

async function sharpMeta(filePath) {
  try {
    const { default: sharp } = await import("sharp");
    const m = await sharp(filePath).metadata();
    return { width: m.width, height: m.height };
  } catch {
    return { width: 0, height: 0 };
  }
}

main().catch((e) => {
  console.error("[asc] FAIL:", e.message || e);
  process.exit(1);
});
