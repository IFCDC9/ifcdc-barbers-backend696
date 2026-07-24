#!/usr/bin/env node
/**
 * Submit the current App Store version for Apple review via App Store Connect API.
 *
 * Uses the modern reviewSubmissions flow (appStoreVersionSubmissions is deprecated).
 *
 * Requires env (or repo .env):
 *   APP_STORE_CONNECT_ISSUER_ID
 *   APP_STORE_CONNECT_KEY_ID
 *   APP_STORE_CONNECT_PRIVATE_KEY_PATH  (path to AuthKey_*.p8)
 *
 * Optional:
 *   APP_VERSION=1.1.9
 *   APP_BUILD_NUMBER=71
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

function readAppJson() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "../app.json"), "utf8"));
    return {
      version: String(j?.expo?.version || ""),
      buildNumber: String(j?.expo?.ios?.buildNumber || ""),
    };
  } catch {
    return { version: "", buildNumber: "" };
  }
}

const root = path.join(__dirname, "../..");
const appJson = readAppJson();
const env = {
  ...loadEnvFile(path.join(root, ".env")),
  ...loadEnvFile(path.join(root, "backend", ".env")),
  ...loadEnvFile(path.join(root, "mobile", ".env")),
  ...process.env,
};

const VERSION_STRING = String(env.APP_VERSION || appJson.version || "1.1.9").trim();
const BUILD_NUMBER = String(env.APP_BUILD_NUMBER || appJson.buildNumber || "71").trim();

const issuerId = env.APP_STORE_CONNECT_ISSUER_ID || env.ASC_ISSUER_ID;
const keyId = env.APP_STORE_CONNECT_KEY_ID || env.ASC_KEY_ID || "AT957SKG93";
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
  // App Store Connect requires IEEE-P1363 (not DER) for ES256.
  const sig = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
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

async function waitForBuildValid(buildId, { attempts = 40, delayMs = 30_000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const b = await asc(`/v1/builds/${buildId}`);
    const state = b.data?.attributes?.processingState;
    console.log(`[asc] build processingState=${state} (poll ${i + 1}/${attempts})`);
    if (state === "VALID") return b.data;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error(`Build processing failed: ${state}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Timed out waiting for build VALID state");
}

async function ensureIosVersion(versionString) {
  const listed = await asc(
    `/v1/apps/${ASC_APP_ID}/appStoreVersions?filter[platform]=IOS&limit=20`,
  );
  const existing =
    listed.data?.find((v) => v.attributes?.versionString === versionString) ||
    listed.data?.find((v) =>
      ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"].includes(
        String(v.attributes?.appStoreState || ""),
      ),
    );
  if (existing?.id) return existing;

  console.log(`[asc] Creating App Store version ${versionString}…`);
  const created = await asc("/v1/appStoreVersions", {
    method: "POST",
    body: {
      data: {
        type: "appStoreVersions",
        attributes: {
          platform: "IOS",
          versionString,
          releaseType: "AFTER_APPROVAL",
        },
        relationships: {
          app: { data: { type: "apps", id: ASC_APP_ID } },
        },
      },
    },
  });
  return created.data;
}

async function submitViaReviewSubmissions(versionId) {
  // Reuse open submission if present
  const open = await asc(
    `/v1/apps/${ASC_APP_ID}/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`,
  ).catch(() => ({ data: [] }));
  let submission = open.data?.[0] || null;

  if (!submission?.id) {
    const created = await asc("/v1/reviewSubmissions", {
      method: "POST",
      body: {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: {
            app: { data: { type: "apps", id: ASC_APP_ID } },
          },
        },
      },
    });
    submission = created.data;
  }
  console.log(`[asc] reviewSubmission id=${submission.id} state=${submission.attributes?.state}`);

  try {
    await asc("/v1/reviewSubmissionItems", {
      method: "POST",
      body: {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
            appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
          },
        },
      },
    });
    console.log("[asc] Added appStoreVersion to reviewSubmission.");
  } catch (e) {
    // Already attached is fine
    console.warn("[asc] reviewSubmissionItems:", e.message);
  }

  const finalized = await asc(`/v1/reviewSubmissions/${submission.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "reviewSubmissions",
        id: submission.id,
        attributes: { submitted: true },
      },
    },
  });
  return finalized.data;
}

async function main() {
  console.log(`[asc] Submitting IFCDC Barbers v${VERSION_STRING} (build ${BUILD_NUMBER}) for App Review…`);

  const version = await ensureIosVersion(VERSION_STRING);
  if (!version?.id) throw new Error("Could not resolve App Store version");
  console.log(`[asc] Version id=${version.id} state=${version.attributes?.appStoreState} string=${version.attributes?.versionString}`);

  const builds = await asc(
    `/v1/builds?filter[app]=${ASC_APP_ID}&filter[version]=${encodeURIComponent(BUILD_NUMBER)}&sort=-uploadedDate&limit=5`,
  );
  const build = builds.data?.[0];
  if (!build?.id) {
    throw new Error(`Build ${BUILD_NUMBER} not found in App Store Connect yet (still uploading/processing?).`);
  }
  console.log(`[asc] Build id=${build.id} processing=${build.attributes?.processingState}`);

  if (build.attributes?.processingState !== "VALID") {
    await waitForBuildValid(build.id);
  }

  try {
    await asc(`/v1/appStoreVersions/${version.id}/relationships/build`, {
      method: "PATCH",
      body: { data: { type: "builds", id: build.id } },
    });
    console.log("[asc] Build attached to version.");
  } catch (e) {
    if (e.status !== 409) console.warn("[asc] Build attach:", e.message);
    else console.log("[asc] Build already attached (409).");
  }

  try {
    const submitted = await submitViaReviewSubmissions(version.id);
    console.log("[asc] SUCCESS — submitted for App Review.");
    console.log(
      JSON.stringify(
        {
          ok: true,
          versionString: VERSION_STRING,
          buildNumber: BUILD_NUMBER,
          versionId: version.id,
          buildId: build.id,
          reviewSubmissionId: submitted?.id || null,
          reviewState: submitted?.attributes?.state || null,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    // Fallback for older ASC tenants still accepting the legacy endpoint.
    console.warn("[asc] reviewSubmissions failed, trying legacy appStoreVersionSubmissions…", e.message);
    const submission = await asc("/v1/appStoreVersionSubmissions", {
      method: "POST",
      body: {
        data: {
          type: "appStoreVersionSubmissions",
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
          },
        },
      },
    });
    console.log("[asc] SUCCESS (legacy) — submission id:", submission.data?.id);
    console.log(
      JSON.stringify(
        {
          ok: true,
          legacy: true,
          versionString: VERSION_STRING,
          buildNumber: BUILD_NUMBER,
          versionId: version.id,
          buildId: build.id,
          submissionId: submission.data?.id || null,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error("[asc] FAIL:", e.message || e);
  if (e.data) console.error(JSON.stringify(e.data, null, 2).slice(0, 2000));
  process.exit(1);
});
