#!/usr/bin/env node
/**
 * Submit the current App Store version for Apple review via App Store Connect API.
 *
 * Requires env (or backend/.env):
 *   APP_STORE_CONNECT_ISSUER_ID
 *   APP_STORE_CONNECT_KEY_ID
 *   APP_STORE_CONNECT_PRIVATE_KEY_PATH  (path to AuthKey_*.p8)
 *
 * Usage:
 *   node mobile/scripts/submit-app-store-review.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASC_APP_ID = "6766149605";
const VERSION_STRING = "1.0";
const BUILD_NUMBER = "36";

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

const root = path.join(__dirname, "../..");
const env = {
  ...loadEnvFile(path.join(root, ".env")),
  ...loadEnvFile(path.join(root, "backend", ".env")),
  ...process.env,
};

const issuerId = env.APP_STORE_CONNECT_ISSUER_ID || env.ASC_ISSUER_ID;
const keyId = env.APP_STORE_CONNECT_KEY_ID || env.ASC_KEY_ID;
const keyPath = env.APP_STORE_CONNECT_PRIVATE_KEY_PATH || env.ASC_KEY_PATH;

if (!issuerId || !keyId || !keyPath) {
  console.error(
    "Missing App Store Connect API credentials. Set APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_PRIVATE_KEY_PATH.",
  );
  process.exit(1);
}

const privateKey = fs.readFileSync(path.resolve(keyPath), "utf8");

function makeJwt() {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("SHA256");
  sign.update(data);
  sign.end();
  const sig = sign.sign(privateKey).toString("base64url");
  return `${data}.${sig}`;
}

async function asc(pathname, { method = "GET", body } = {}) {
  const token = makeJwt();
  const res = await fetch(`https://api.appstoreconnect.apple.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
    const err = new Error(data?.errors?.[0]?.detail || data?.errors?.[0]?.title || text.slice(0, 300));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  console.log(`[asc] Submitting IFCDC Barbers v${VERSION_STRING} (${BUILD_NUMBER}) for review…`);

  const versions = await asc(
    `/v1/apps/${ASC_APP_ID}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY&limit=5`,
  );
  const version =
    versions.data?.find((v) => v.attributes?.versionString === VERSION_STRING) || versions.data?.[0];
  if (!version?.id) {
    throw new Error("No editable App Store version found. Create version 1.0 in App Store Connect.");
  }
  console.log(`[asc] Version id: ${version.id} state: ${version.attributes?.appStoreState}`);

  const builds = await asc(
    `/v1/builds?filter[app]=${ASC_APP_ID}&filter[version]=${BUILD_NUMBER}&limit=5`,
  );
  const build = builds.data?.[0];
  if (!build?.id) {
    throw new Error(`Build ${BUILD_NUMBER} not found or still processing in App Store Connect.`);
  }
  console.log(`[asc] Build id: ${build.id} processing: ${build.attributes?.processingState}`);

  try {
    await asc(`/v1/appStoreVersions/${version.id}/relationships/build`, {
      method: "PATCH",
      body: { data: { type: "builds", id: build.id } },
    });
    console.log("[asc] Build attached to version.");
  } catch (e) {
    if (e.status !== 409) console.warn("[asc] Build attach:", e.message);
  }

  const submission = await asc("/v1/appStoreVersionSubmissions", {
    method: "POST",
    body: { data: { type: "appStoreVersionSubmissions", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } } },
  });
  console.log("[asc] Submission created:", submission.data?.id);
  console.log("[asc] SUCCESS — IFCDC Barbers is in Apple's review queue.");
}

main().catch((e) => {
  console.error("[asc] FAIL:", e.message || e);
  process.exit(1);
});
