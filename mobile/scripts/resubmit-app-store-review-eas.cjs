#!/usr/bin/env node
/**
 * Resubmit an editable App Store version for review using EAS-stored ASC API credentials
 * (same auth path as `eas metadata:push`).
 *
 * Usage (from repo root):
 *   node mobile/scripts/resubmit-app-store-review-eas.cjs
 */
"use strict";

const path = require("path");
const { Platform } = require("@expo/eas-build-job");
const { createRequire } = require("module");

const mobileDir = path.resolve(__dirname, "..");
process.chdir(mobileDir);

const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));

const VERSION_STRING = "1.1";
const BUILD_NUMBER = "39";

async function main() {
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
  const { Platform: ApplePlatform } = req("@expo/apple-utils");

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
    profileName: undefined,
    projectDir,
  });
  if (submitProfiles.length !== 1) {
    throw new Error("Expected exactly one iOS submit profile in eas.json");
  }
  const submitProfile = submitProfiles[0].profile;

  const credentialsCtx = new CredentialsContext({
    projectInfo: { exp, projectId },
    projectDir,
    user: loggedIn.actor,
    graphqlClient: loggedIn.graphqlClient,
    analytics,
    nonInteractive: true,
    vcsClient,
  });

  const { app } = await getAppStoreAuthAsync({
    projectDir,
    profile: submitProfile,
    exp,
    credentialsCtx,
    nonInteractive: true,
    graphqlClient: loggedIn.graphqlClient,
    projectId,
  });

  const versions = await app.getAppStoreVersionsAsync({
    query: {
      limit: 10,
      filter: { platform: ApplePlatform.IOS },
    },
  });
  const version =
    versions.find((v) => v.attributes.versionString === VERSION_STRING) ||
    (await app.getEditAppStoreVersionAsync({ platform: ApplePlatform.IOS }));

  if (!version) {
    throw new Error(`App Store version ${VERSION_STRING} not found`);
  }

  console.log(
    `[asc] Version ${version.attributes.versionString} state=${version.attributes.appStoreState}`,
  );

  const reviewDetail = await version.getAppStoreReviewDetailAsync();
  if (reviewDetail) {
    console.log(
      `[asc] Review detail: signInRequired=${reviewDetail.attributes.demoAccountRequired} user=${reviewDetail.attributes.demoAccountName || "(none)"}`,
    );
  } else {
    console.warn("[asc] No review detail on version — metadata push may not have synced yet.");
  }

  const attached = await version.getBuildAsync();
  if (attached && String(attached.attributes.version) === BUILD_NUMBER) {
    console.log(`[asc] Build ${BUILD_NUMBER} already attached (id=${attached.id})`);
  } else {
    const builds = await app.getBuildsAsync({ query: { limit: 50 } });
    const build = builds.find((b) => String(b.attributes.version) === BUILD_NUMBER);
    if (!build) {
      throw new Error(`Build ${BUILD_NUMBER} not found in App Store Connect`);
    }
    console.log(
      `[asc] Build ${BUILD_NUMBER} id=${build.id} processing=${build.attributes.processingState}`,
    );
    await version.updateBuildAsync({ buildId: build.id });
    console.log(`[asc] Attached Build ${BUILD_NUMBER} to version ${VERSION_STRING}`);
  }

  let reviewSubmission = await app.getReadyReviewSubmissionAsync({ platform: ApplePlatform.IOS });

  if (!reviewSubmission) {
    const inProgress = await app.getInProgressReviewSubmissionAsync({ platform: ApplePlatform.IOS });
    if (inProgress?.attributes?.state === "UNRESOLVED_ISSUES") {
      console.log(`[asc] Cancelling unresolved submission ${inProgress.id}`);
      await inProgress.cancelSubmissionAsync();
      reviewSubmission = null;
    } else if (inProgress && inProgress.attributes?.state !== "COMPLETE") {
      reviewSubmission = inProgress;
    }
  }

  if (reviewSubmission) {
    console.log(
      `[asc] Using review submission ${reviewSubmission.id} state=${reviewSubmission.attributes.state}`,
    );
    try {
      await reviewSubmission.addAppStoreVersionToReviewItems(version.id);
      console.log("[asc] Added version 1.0 to review submission");
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes("already")) {
        throw e;
      }
      console.log("[asc] Version already linked to a review submission");
    }
  } else {
    reviewSubmission = await app.createReviewSubmissionAsync({
      platform: ApplePlatform.IOS,
    });
    console.log(`[asc] Created review submission ${reviewSubmission.id}`);
    await reviewSubmission.addAppStoreVersionToReviewItems(version.id);
    console.log("[asc] Added version 1.0 to review submission");
  }

  await reviewSubmission.submitForReviewAsync();
  console.log(`[asc] Review submission ${reviewSubmission.id} submitted for App Review`);
  console.log(`[asc] SUCCESS — IFCDC Barbers v${VERSION_STRING} (Build ${BUILD_NUMBER}) resubmitted for App Review.`);
}

main().catch((e) => {
  console.error("[asc] FAIL:", e?.message || e);
  process.exit(1);
});
