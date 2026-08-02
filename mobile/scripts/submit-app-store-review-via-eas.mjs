#!/usr/bin/env node
/**
 * Submit IFCDC Barbers for App Store Review using EAS-stored ASC API key
 * + @expo/apple-utils (same auth path as `eas metadata:push`).
 *
 * Usage (from mobile/):
 *   node scripts/submit-app-store-review-via-eas.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, "..");
const require = createRequire(path.join(mobileRoot, "package.json"));

const appJson = JSON.parse(fs.readFileSync(path.join(mobileRoot, "app.json"), "utf8"));
const VERSION_STRING = String(process.env.APP_VERSION || appJson.expo?.version || "1.1.9");
const BUILD_NUMBER = String(process.env.APP_BUILD_NUMBER || appJson.expo?.ios?.buildNumber || "71");
const BUNDLE_ID = String(appJson.expo?.ios?.bundleIdentifier || "com.ifcdc.barbers");
const PROJECT_ID = String(appJson.expo?.extra?.eas?.projectId || "");
const ACCOUNT = "ifcdc696";
const SLUG = String(appJson.expo?.slug || "ifcdc-barbers-backend");

const apple = require("@expo/apple-utils");
const SessionManagerMod = require("eas-cli/build/user/SessionManager.js");
const SessionManager = SessionManagerMod.default || SessionManagerMod.SessionManager;
const { createGraphqlClient } = require("eas-cli/build/commandUtils/context/contextUtils/createGraphqlClient.js");
const {
  getAscApiKeyForAppSubmissionsAsync,
} = require("eas-cli/build/credentials/ios/api/GraphqlClient.js");
const {
  AppStoreConnectApiKeyQuery,
} = require("eas-cli/build/graphql/queries/AppStoreConnectApiKeyQuery.js");
const { getOwnerAccountForProjectIdAsync } = require("eas-cli/build/project/projectUtils.js");
const { authenticateAsync, getRequestContext } = require("eas-cli/build/credentials/ios/appstore/authenticate.js");
const { AuthenticationMode, AppleTeamType } = require("eas-cli/build/credentials/ios/appstore/authenticateTypes.js");

const analytics = {
  setActor() {},
  logEvent() {},
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitBuildValid(build, attempts = 60) {
  let current = build;
  for (let i = 0; i < attempts; i += 1) {
    const state = current?.attributes?.processingState || current?.processingState;
    console.log(`[asc] build processingState=${state} (poll ${i + 1}/${attempts})`);
    if (state === "VALID") return current;
    if (state === "FAILED" || state === "INVALID") {
      throw new Error(`Build processing failed: ${state}`);
    }
    await sleep(30_000);
    if (typeof current?.reloadAsync === "function") {
      current = await current.reloadAsync();
    } else if (typeof apple.Build?.getAsync === "function") {
      current = await apple.Build.getAsync(current.context, { id: current.id });
    } else {
      // Fall through with same object; getBuildsAsync will be re-queried by caller if needed
      break;
    }
  }
  return current;
}

async function main() {
  console.log(`[asc] Preparing App Review submission for v${VERSION_STRING} build ${BUILD_NUMBER}…`);

  const sessionManager = new SessionManager(analytics);
  const accessToken = sessionManager.getAccessToken();
  const sessionSecret = sessionManager.getSessionSecret();
  if (!accessToken && !sessionSecret) {
    throw new Error("Not logged in to Expo. Run `npx eas-cli login` then retry.");
  }
  const graphqlClient = createGraphqlClient({ accessToken, sessionSecret });

  const account = PROJECT_ID
    ? await getOwnerAccountForProjectIdAsync(graphqlClient, PROJECT_ID)
    : { name: ACCOUNT, id: null };

  const appLookupParams = {
    account,
    projectName: SLUG,
    bundleIdentifier: BUNDLE_ID,
  };

  const ascKeyFragment = await getAscApiKeyForAppSubmissionsAsync(graphqlClient, appLookupParams);
  if (!ascKeyFragment?.id) {
    throw new Error("No ASC API key found in EAS credentials for this app.");
  }
  const fullKey = await AppStoreConnectApiKeyQuery.getByIdAsync(graphqlClient, ascKeyFragment.id);
  console.log(`[asc] Using EAS ASC key id=${fullKey.keyIdentifier}`);

  const authCtx = await authenticateAsync({
    mode: AuthenticationMode.API_KEY,
    ascApiKey: {
      keyP8: fullKey.keyP8,
      keyId: fullKey.keyIdentifier,
      issuerId: fullKey.issuerIdentifier,
    },
    teamId: ascKeyFragment.appleTeam?.appleTeamIdentifier,
    teamName: ascKeyFragment.appleTeam?.appleTeamName ?? undefined,
    teamType: AppleTeamType.COMPANY_OR_ORGANIZATION,
  });
  const ctx = getRequestContext(authCtx);

  const app = await apple.App.findAsync(ctx, { bundleId: BUNDLE_ID });
  if (!app) throw new Error(`App not found for bundle ${BUNDLE_ID}`);
  console.log(`[asc] App id=${app.id}`);

  // Ensure editable version exists
  let version =
    (await app.getEditAppStoreVersionAsync({ platform: apple.Platform.IOS }).catch(() => null)) ||
    null;
  if (!version || String(version.attributes?.versionString) !== VERSION_STRING) {
    console.log(`[asc] Ensuring App Store version ${VERSION_STRING}…`);
    version = await app.ensureVersionAsync(VERSION_STRING, {
      platform: apple.Platform.IOS,
    });
  }
  console.log(
    `[asc] Version id=${version.id} string=${version.attributes?.versionString} state=${version.attributes?.appStoreState}`,
  );

  // Find build by CFBundleVersion
  let builds = await app.getBuildsAsync({
    filter: { version: BUILD_NUMBER, processingState: "VALID,PROCESSING,UPLOADING" },
  });
  if (!Array.isArray(builds)) builds = builds?.data || [];
  let build = builds.find((b) => String(b.attributes?.version) === BUILD_NUMBER) || builds[0];
  if (!build) {
    // Retry briefly — ASC processing lag after EAS submit
    for (let i = 0; i < 20 && !build; i += 1) {
      console.log(`[asc] Build ${BUILD_NUMBER} not visible yet; waiting… (${i + 1}/20)`);
      await sleep(30_000);
      builds = await app.getBuildsAsync({
        filter: { version: BUILD_NUMBER, processingState: "VALID,PROCESSING,UPLOADING" },
      });
      if (!Array.isArray(builds)) builds = builds?.data || [];
      build = builds.find((b) => String(b.attributes?.version) === BUILD_NUMBER) || builds[0];
    }
  }
  if (!build) throw new Error(`Build ${BUILD_NUMBER} not found in App Store Connect.`);
  console.log(`[asc] Build id=${build.id} processing=${build.attributes?.processingState}`);

  if (build.attributes?.processingState !== "VALID") {
    build = await waitBuildValid(build);
    if (build.attributes?.processingState !== "VALID") {
      // Re-fetch
      builds = await app.getBuildsAsync({ filter: { version: BUILD_NUMBER, processingState: "VALID" } });
      if (!Array.isArray(builds)) builds = builds?.data || [];
      build = builds[0];
    }
  }
  if (!build || build.attributes?.processingState !== "VALID") {
    throw new Error(`Build ${BUILD_NUMBER} is not VALID yet.`);
  }

  try {
    await version.updateBuildAsync({ buildId: build.id });
    console.log("[asc] Attached build to version.");
  } catch (e) {
    console.warn("[asc] updateBuildAsync:", e?.message || e);
  }

  // Prefer ready submission, else create
  let submission =
    (await app.getReadyReviewSubmissionAsync({ platform: apple.Platform.IOS }).catch(() => null)) ||
    (await app.getInProgressReviewSubmissionAsync({ platform: apple.Platform.IOS }).catch(() => null)) ||
    null;
  if (!submission) {
    submission = await app.createReviewSubmissionAsync({ platform: apple.Platform.IOS });
  }
  console.log(`[asc] reviewSubmission id=${submission.id} state=${submission.attributes?.state}`);

  try {
    if (typeof submission.addAppStoreVersionToReviewItems === "function") {
      await submission.addAppStoreVersionToReviewItems({ versionId: version.id });
      console.log("[asc] Added version to review submission items.");
    }
  } catch (e) {
    console.warn("[asc] addAppStoreVersionToReviewItems:", e?.message || e);
  }

  const submitted = await submission.submitForReviewAsync();
  console.log("[asc] SUCCESS — submitted for App Review.");
  console.log(
    JSON.stringify(
      {
        ok: true,
        versionString: VERSION_STRING,
        buildNumber: BUILD_NUMBER,
        appId: app.id,
        versionId: version.id,
        buildId: build.id,
        reviewSubmissionId: submitted?.id || submission.id,
        reviewState: submitted?.attributes?.state || submission.attributes?.state || null,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("[asc] FAIL:", e?.message || e);
  if (e?.data) console.error(JSON.stringify(e.data, null, 2).slice(0, 2000));
  process.exit(1);
});
