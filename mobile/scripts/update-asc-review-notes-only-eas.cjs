#!/usr/bin/env node
/**
 * Update App Review notes only — does NOT resubmit, cancel, or change the attached build.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Platform } = require("@expo/eas-build-job");
const { createRequire } = require("module");

const mobileDir = path.resolve(__dirname, "..");
process.chdir(mobileDir);

const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));
const VERSION_STRING = "1.0";

function readReviewConfig() {
  const storePath = path.join(mobileDir, "store.config.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const review = store?.apple?.review || {};
  const notes = String(review.notes || "").trim();
  if (!notes) {
    throw new Error("store.config.json apple.review.notes is empty");
  }
  return { review, notes };
}

async function main() {
  const { review, notes } = readReviewConfig();
  if (Buffer.byteLength(notes, "utf8") > 4000) {
    throw new Error(`Review notes exceed 4000 bytes (${Buffer.byteLength(notes, "utf8")})`);
  }

  const videoPath = process.argv[2] || path.join(mobileDir, "store/account-deletion-demo-build36.mp4");

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
    projectDir,
  });
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
    query: { limit: 10, filter: { platform: ApplePlatform.IOS } },
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
  if (!reviewDetail) {
    throw new Error("No App Store Review Detail on this version");
  }

  const current = reviewDetail.attributes || {};

  const attached = await version.getBuildAsync();
  console.log(
    `[asc] Attached build: ${attached ? `${attached.attributes.version} (${attached.id})` : "(none)"}`,
  );

  const inProgress = await app.getInProgressReviewSubmissionAsync({ platform: ApplePlatform.IOS });
  console.log(
    `[asc] In-progress submission: ${inProgress ? `${inProgress.id} ${inProgress.attributes.state}` : "(none)"}`,
  );

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

  if (fs.existsSync(videoPath)) {
    console.log(`[asc] Uploading review attachment: ${videoPath}`);
    await reviewDetail.uploadAttachmentAsync(videoPath);
    console.log("[asc] Review attachment uploaded.");
  } else {
    console.warn(`[asc] Review attachment skipped (file not found): ${videoPath}`);
  }

  const refreshed = await version.getAppStoreReviewDetailAsync();
  console.log(`[asc] Notes updated (${Buffer.byteLength(String(refreshed.attributes.notes || ""), "utf8")} bytes)`);
  const attachments = refreshed.attributes.appStoreReviewAttachments || [];
  console.log(`[asc] Review attachments: ${attachments.length}`);
  console.log("[asc] Done — submission and build were not modified.");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
