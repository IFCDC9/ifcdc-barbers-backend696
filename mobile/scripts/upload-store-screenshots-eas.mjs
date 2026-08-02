#!/usr/bin/env node
/**
 * Upload store.config.json screenshots to App Store version using EAS ASC API key.
 * Targets the editable version (1.1.9 by default). Does not submit for review.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";
import { createSign } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, "..");
const require = createRequire(path.join(mobileRoot, "node_modules/eas-cli/package.json"));

const appJson = JSON.parse(fs.readFileSync(path.join(mobileRoot, "app.json"), "utf8"));
const store = JSON.parse(fs.readFileSync(path.join(mobileRoot, "store.config.json"), "utf8"));
const VERSION_STRING = String(process.env.APP_VERSION || appJson.expo?.version || "1.1.9");
const BUNDLE_ID = String(appJson.expo?.ios?.bundleIdentifier || "com.ifcdc.barbers");
const PROJECT_ID = String(appJson.expo?.extra?.eas?.projectId || "");
const SLUG = String(appJson.expo?.slug || "ifcdc-barbers-backend");
const ASC_APP_ID = "6766149605";

const { SessionManager } = (() => {
  const mod = require("eas-cli/build/user/SessionManager.js");
  return { SessionManager: mod.default || mod.SessionManager };
})();
const { createGraphqlClient } = require("eas-cli/build/commandUtils/context/contextUtils/createGraphqlClient.js");
const {
  getAscApiKeyForAppSubmissionsAsync,
} = require("eas-cli/build/credentials/ios/api/GraphqlClient.js");
const {
  AppStoreConnectApiKeyQuery,
} = require("eas-cli/build/graphql/queries/AppStoreConnectApiKeyQuery.js");
const { getOwnerAccountForProjectIdAsync } = require("eas-cli/build/project/projectUtils.js");

const analytics = { setActor() {}, logEvent() {} };

function jwtFromKey({ keyP8, keyId, issuerId }) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("SHA256");
  sign.update(data);
  sign.end();
  // ASC expects IEEE-P1363; Node's sign for ES256 is DER by default — convert if needed.
  // Use jose-style: dsaEncoding ieee-p1363 when available.
  let sig;
  try {
    sig = sign.sign({ key: keyP8, dsaEncoding: "ieee-p1363" });
  } catch {
    sig = sign.sign(keyP8);
  }
  return `${data}.${sig.toString("base64url")}`;
}

async function asc(token, pathname, { method = "GET", body } = {}) {
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
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || text.slice(0, 500);
    const err = new Error(detail);
    err.data = data;
    throw err;
  }
  return data;
}

async function uploadBinary(uploadOperations, filePath) {
  const buf = fs.readFileSync(filePath);
  for (const op of uploadOperations || []) {
    const headers = {};
    for (const h of op.requestHeaders || []) headers[h.name] = h.value;
    const res = await fetch(op.url, {
      method: op.method || "PUT",
      headers,
      body: buf.subarray(op.offset || 0, (op.offset || 0) + (op.length || buf.length)),
    });
    if (!res.ok) throw new Error(`Binary upload failed ${res.status} for ${path.basename(filePath)}`);
  }
}

async function listScreenshotSets(token, locId) {
  const existing = await asc(
    token,
    `/v1/appStoreVersionLocalizations/${locId}/appScreenshotSets`,
  );
  return existing.data || [];
}

async function ensureScreenshotSet(token, locId, displayType) {
  const sets = await listScreenshotSets(token, locId);
  const match = sets.find((s) => s.attributes?.screenshotDisplayType === displayType);
  if (match?.id) {
    const setId = match.id;
    // Clear existing screenshots so we can re-upload baseline set
    const shots = await asc(token, `/v1/appScreenshotSets/${setId}/appScreenshots`);
    for (const s of shots.data || []) {
      await asc(token, `/v1/appScreenshots/${s.id}`, { method: "DELETE" }).catch(() => {});
    }
    return setId;
  }
  const created = await asc(token, "/v1/appScreenshotSets", {
    method: "POST",
    body: {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: displayType },
        relationships: {
          appStoreVersionLocalization: {
            data: { type: "appStoreVersionLocalizations", id: locId },
          },
        },
      },
    },
  });
  return created.data.id;
}

async function uploadShot(token, setId, filePath) {
  const fileName = path.basename(filePath);
  const size = fs.statSync(filePath).size;
  const checksum = crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("base64");
  const reserved = await asc(token, "/v1/appScreenshots", {
    method: "POST",
    body: {
      data: {
        type: "appScreenshots",
        attributes: { fileName, fileSize: size },
        relationships: {
          appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
        },
      },
    },
  });
  const shotId = reserved.data.id;
  await uploadBinary(reserved.data.attributes.uploadOperations, filePath);
  await asc(token, `/v1/appScreenshots/${shotId}`, {
    method: "PATCH",
    body: {
      data: {
        type: "appScreenshots",
        id: shotId,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    },
  });
  console.log(`  ✓ ${fileName}`);
}

async function ensurePrivacyUrl(token, privacyUrl) {
  const infos = await asc(token, `/v1/apps/${ASC_APP_ID}/appInfos`);
  const infoId = infos.data?.[0]?.id;
  if (!infoId) {
    console.warn("[asc] No appInfos found; skipping privacy URL");
    return;
  }
  const locs = await asc(token, `/v1/appInfos/${infoId}/appInfoLocalizations`);
  const en = (locs.data || []).find((l) => l.attributes?.locale === "en-US") || locs.data?.[0];
  if (!en?.id) {
    console.warn("[asc] No appInfoLocalization; skipping privacy URL");
    return;
  }
  try {
    await asc(token, `/v1/appInfoLocalizations/${en.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appInfoLocalizations",
          id: en.id,
          attributes: { privacyPolicyUrl: privacyUrl },
        },
      },
    });
    console.log(`[asc] privacyPolicyUrl set on appInfoLocalization (${en.attributes.locale})`);
  } catch (e) {
    // Often locked when an App Info / prior version is already LIVE — read current value instead.
    const current = en.attributes?.privacyPolicyUrl || null;
    console.warn(
      `[asc] privacyPolicyUrl not writable (${e.message}). current=${current || "(empty)"}`,
    );
  }
}

async function main() {
  const sessionManager = new SessionManager(analytics);
  const accessToken = sessionManager.getAccessToken();
  const sessionSecret = sessionManager.getSessionSecret();
  if (!accessToken && !sessionSecret) throw new Error("Not logged in to Expo");
  const graphqlClient = createGraphqlClient({ accessToken, sessionSecret });
  const account = PROJECT_ID
    ? await getOwnerAccountForProjectIdAsync(graphqlClient, PROJECT_ID)
    : { name: "ifcdc696", id: null };
  const ascKeyFragment = await getAscApiKeyForAppSubmissionsAsync(graphqlClient, {
    account,
    projectName: SLUG,
    bundleIdentifier: BUNDLE_ID,
  });
  if (!ascKeyFragment?.id) throw new Error("No ASC API key in EAS");
  const fullKey = await AppStoreConnectApiKeyQuery.getByIdAsync(graphqlClient, ascKeyFragment.id);
  const token = jwtFromKey({
    keyP8: fullKey.keyP8,
    keyId: fullKey.keyIdentifier,
    issuerId: fullKey.issuerIdentifier,
  });

  const privacyUrl = store?.apple?.info?.["en-US"]?.privacyPolicyUrl;
  if (privacyUrl) await ensurePrivacyUrl(token, privacyUrl);

  const versions = await asc(
    token,
    `/v1/apps/${ASC_APP_ID}/appStoreVersions?filter[platform]=IOS&limit=20`,
  );
  const version = (versions.data || []).find((v) => v.attributes?.versionString === VERSION_STRING);
  if (!version?.id) throw new Error(`Version ${VERSION_STRING} not found`);
  console.log(`[asc] Version ${VERSION_STRING} id=${version.id} state=${version.attributes.appStoreState}`);

  const locs = await asc(token, `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  const loc = (locs.data || []).find((l) => l.attributes?.locale === "en-US") || locs.data?.[0];
  if (!loc?.id) throw new Error("No en-US version localization");

  const shots = store?.apple?.info?.["en-US"]?.screenshots || {};
  for (const [displayType, files] of Object.entries(shots)) {
    console.log(`[asc] Uploading ${displayType} (${files.length} files)…`);
    const setId = await ensureScreenshotSet(token, loc.id, displayType);
    // Upload Home first for App Store order (01_ → last in reverse-listed config)
    const ordered = [...files].sort((a, b) => {
      const na = Number((path.basename(a).match(/-(\d+)_/) || [])[1] || 99);
      const nb = Number((path.basename(b).match(/-(\d+)_/) || [])[1] || 99);
      return na - nb;
    });
    for (const rel of ordered) {
      const filePath = path.join(mobileRoot, rel);
      if (!fs.existsSync(filePath)) throw new Error(`Missing screenshot: ${rel}`);
      await uploadShot(token, setId, filePath);
    }
  }

  console.log("[asc] Screenshot + privacy sync complete.");
}

main().catch((e) => {
  console.error("[asc] FAIL:", e.message || e);
  if (e.data) console.error(JSON.stringify(e.data, null, 2).slice(0, 1500));
  process.exit(1);
});
