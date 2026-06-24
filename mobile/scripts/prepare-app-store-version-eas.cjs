#!/usr/bin/env node
/**
 * Prepare an App Store version: attach build, sync release/review notes.
 * Does NOT submit for App Review — user submits manually in App Store Connect.
 *
 * Usage:
 *   node scripts/prepare-app-store-version-eas.cjs
 *   VERSION_STRING=1.1 BUILD_NUMBER=39 node scripts/prepare-app-store-version-eas.cjs
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Platform } = require("@expo/eas-build-job");
const { createRequire } = require("module");

const mobileDir = path.resolve(__dirname, "..");
process.chdir(mobileDir);

const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));

const VERSION_STRING = process.env.VERSION_STRING || "1.1";
const BUILD_NUMBER = process.env.BUILD_NUMBER || "39";
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 20 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS || 30 * 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStoreConfig() {
  const storePath = path.join(mobileDir, "store.config.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const review = store?.apple?.review || {};
  const notes = String(review.notes || "").trim();
  const releaseNotes = String(store?.apple?.info?.["en-US"]?.releaseNotes || "").trim();
  if (!notes) throw new Error("store.config.json apple.review.notes is empty");
  return { review, notes, releaseNotes };
}

async function getAuth(app) {
  const { createAnalyticsAsync } = req("eas-cli/build/analytics/AnalyticsManager");
  const SessionManager = req("eas-cli/build/user/SessionManager").default;
  const LoggedInContextField = req("eas-cli/build/commandUtils/context/LoggedInContextField").default;
  const {
    PrivateProjectConfigContextField,
  } = req("eas-cli/build/commandUtils/context/PrivateProjectConfigContextField");
  const VcsClientContextField = req("eas-cli/build/commandUtils/context/VcsClientContextField").default;
  const { CredentialsContext } = req("eas-cli/build/credentials/context");
  const { getProfilesAsync } = req("eas-cli/build/utils/profiles");
  const { EasJsonAccessor } = req("@expo/eas-json");
  const { getAppStoreAuthAsync } = req("eas-cli/build/metadata/auth");

  const analytics = await createAnalyticsAsync();
  const sessionManager = new SessionManager(analytics);
  const loggedIn = await new LoggedInContextField().getValueAsync({
    nonInteractive: true,
    sessionManager,
  });
  const projectConfig = await new PrivateProjectConfigContextField().getValueAsync({
    nonInteractive: true,
    sessionManager,
    withServerSideEnvironment: null,
  });
  const vcsClient = await new VcsClientContextField().getValueAsync({});
  const { exp, projectId, projectDir } = projectConfig;
  const submitProfiles = await getProfilesAsync({
    type: "submit",
    easJsonAccessor: EasJsonAccessor.fromProjectPath(projectDir),
    platforms: [Platform.IOS],
    projectDir,
  });
  const credentialsCtx = new CredentialsContext({
    projectInfo: { exp, projectId },
    projectDir,
    user: loggedIn.actor,
    graphqlClient: loggedIn.graphqlClient,
    analytics,
    nonInteractive: true,
    vcsClient,
  });
  return getAppStoreAuthAsync({
    projectDir,
    profile: submitProfiles[0].profile,
    exp,
    credentialsCtx,
    nonInteractive: true,
    graphqlClient: loggedIn.graphqlClient,
    projectId,
  });
}

async function findVersion(app, ApplePlatform) {
  const versions = await app.getAppStoreVersionsAsync({
    query: { limit: 20, filter: { platform: ApplePlatform.IOS } },
  });
  return (
    versions.find((v) => v.attributes.versionString === VERSION_STRING) ||
    (await app.getEditAppStoreVersionAsync({ platform: ApplePlatform.IOS }))
  );
}

async function waitForBuild(app) {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const builds = await app.getBuildsAsync({ query: { limit: 50 } });
    const build = builds.find((b) => String(b.attributes.version) === BUILD_NUMBER);
    if (build) {
      const state = build.attributes.processingState;
      console.log(`[asc] Build ${BUILD_NUMBER} id=${build.id} state=${state}`);
      if (state === "VALID") return build;
      if (state === "FAILED" || state === "INVALID") {
        throw new Error(`Build ${BUILD_NUMBER} processing failed: ${state}`);
      }
    } else {
      console.log(`[asc] Build ${BUILD_NUMBER} not visible yet — waiting…`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for Build ${BUILD_NUMBER} to become VALID`);
}

async function main() {
  const { Platform: ApplePlatform } = req("@expo/apple-utils");
  const { review, notes, releaseNotes } = readStoreConfig();
  const { app } = await getAuth();

  let version = await findVersion(app, ApplePlatform);
  if (!version || version.attributes.versionString !== VERSION_STRING) {
    console.log(`[asc] Version ${VERSION_STRING} not found — run: eas metadata:push`);
    version = await findVersion(app, ApplePlatform);
  }
  if (!version) {
    throw new Error(`App Store version ${VERSION_STRING} not found. Run eas metadata:push first.`);
  }

  console.log(
    `[asc] Version ${version.attributes.versionString} state=${version.attributes.appStoreState}`,
  );

  const build = await waitForBuild(app);

  const attached = await version.getBuildAsync();
  if (attached && String(attached.attributes.version) === BUILD_NUMBER) {
    console.log(`[asc] Build ${BUILD_NUMBER} already attached`);
  } else {
    await version.updateBuildAsync({ buildId: build.id });
    console.log(`[asc] Attached Build ${BUILD_NUMBER} to version ${VERSION_STRING}`);
  }

  if (releaseNotes) {
    const locs = await version.getLocalizationsAsync();
    const en = locs.find((l) => l.attributes.locale === "en-US") || locs[0];
    if (en && en.attributes.whatsNew !== releaseNotes) {
      await en.updateAsync({ whatsNew: releaseNotes });
      console.log("[asc] Updated What's New (release notes)");
    }
  }

  const reviewDetail = await version.getAppStoreReviewDetailAsync();
  if (reviewDetail) {
    const current = reviewDetail.attributes || {};
    await reviewDetail.updateAsync({
      contactFirstName: current.contactFirstName || review.firstName,
      contactLastName: current.contactLastName || review.lastName,
      contactEmail: current.contactEmail || review.email,
      contactPhone: current.contactPhone || review.phone,
      demoAccountRequired: current.demoAccountRequired ?? review.demoRequired ?? true,
      demoAccountName: current.demoAccountName || review.demoUsername,
      demoAccountPassword: current.demoAccountPassword || review.demoPassword,
      notes,
    });
    console.log("[asc] Updated App Review notes");
  }

  const finalBuild = await version.getBuildAsync();
  console.log(
    `[asc] READY — v${VERSION_STRING} (Build ${finalBuild?.attributes?.version}) state=${version.attributes.appStoreState}`,
  );
  console.log("[asc] Submit for review manually in App Store Connect when ready.");
}

main().catch((e) => {
  console.error("[asc] FAIL:", e?.message || e);
  process.exit(1);
});
