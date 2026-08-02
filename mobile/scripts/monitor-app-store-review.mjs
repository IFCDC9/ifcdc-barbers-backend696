#!/usr/bin/env node
/**
 * Poll App Store Connect for IFCDC Barbers v1.1.9 review/release state changes.
 * Writes status to backups/app-store-release-monitor.json and prints ALERT lines on change.
 *
 * Usage (from mobile/):
 *   node scripts/monitor-app-store-review.mjs
 *   INTERVAL_MS=300000 MAX_HOURS=48 node scripts/monitor-app-store-review.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.join(__dirname, "..");
const repoRoot = path.join(mobileDir, "..");
process.chdir(mobileDir);

const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));
const VERSION_STRING = process.env.APP_VERSION || "1.1.9";
const BUILD_NUMBER = process.env.APP_BUILD_NUMBER || "73";
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5 * 60 * 1000);
const MAX_HOURS = Number(process.env.MAX_HOURS || 48);
const OUT = path.join(repoRoot, "backups", "app-store-release-monitor.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  const { Platform } = req("@expo/eas-build-job");
  const apple = req("@expo/apple-utils");
  const ApplePlatform = apple.Platform;
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
  const { app } = await getAppStoreAuthAsync({
    projectDir,
    profile: submitProfiles[0].profile,
    exp,
    credentialsCtx,
    nonInteractive: true,
    graphqlClient: loggedIn.graphqlClient,
    projectId,
  });

  const versions = await app.getAppStoreVersionsAsync({
    query: { limit: 8, filter: { platform: ApplePlatform.IOS } },
  });
  const target = versions.find((v) => v.attributes.versionString === VERSION_STRING);
  let build = null;
  if (target) {
    try {
      const b = await target.getBuildAsync();
      build = b
        ? { version: b.attributes.version, processingState: b.attributes.processingState }
        : null;
    } catch {
      build = null;
    }
  }
  const inProgress = await app
    .getInProgressReviewSubmissionAsync({ platform: ApplePlatform.IOS })
    .catch(() => null);

  const state = {
    checkedAt: new Date().toISOString(),
    versionString: VERSION_STRING,
    expectedBuild: BUILD_NUMBER,
    appStoreState: target?.attributes?.appStoreState || null,
    appVersionState: target?.attributes?.appVersionState || null,
    releaseType: target?.attributes?.releaseType || null,
    build,
    reviewSubmission: inProgress
      ? { id: inProgress.id, state: inProgress.attributes.state }
      : null,
    needsAction: false,
    actionHint: null,
  };

  const s = `${state.appStoreState || ""}|${state.reviewSubmission?.state || ""}`;
  if (/REJECTED|INVALID|DEVELOPER_REJECTED|METADATA_REJECTED|PENDING_DEVELOPER|UNRESOLVED/i.test(s)) {
    state.needsAction = true;
    state.actionHint = "Apple feedback or rejection — open App Store Connect and respond.";
  } else if (/READY_FOR_SALE|READY_FOR_DISTRIBUTION/i.test(state.appStoreState || "")) {
    state.actionHint = "Version is live / ready for distribution.";
  } else if (/PENDING_APPLE_RELEASE|PENDING_DEVELOPER_RELEASE/i.test(state.appStoreState || "")) {
    state.needsAction = /PENDING_DEVELOPER_RELEASE/i.test(state.appStoreState || "");
    state.actionHint = state.needsAction
      ? "Approved — manual release required."
      : "Approved — waiting on Apple release timing.";
  } else if (/IN_REVIEW|WAITING_FOR_REVIEW/i.test(s)) {
    state.actionHint = "In Apple review queue — no action needed.";
  }

  return state;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let lastKey = null;
  const deadline = Date.now() + MAX_HOURS * 60 * 60 * 1000;
  console.log(
    `[monitor] Watching v${VERSION_STRING} build ${BUILD_NUMBER} every ${INTERVAL_MS / 1000}s for up to ${MAX_HOURS}h`,
  );
  while (Date.now() < deadline) {
    try {
      const state = await probe();
      fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
      const key = `${state.appStoreState}|${state.reviewSubmission?.state}|${state.build?.version}|${state.needsAction}`;
      if (key !== lastKey) {
        const tag = state.needsAction ? "ALERT_ACTION_REQUIRED" : "STATUS";
        console.log(`[monitor] ${tag} ${JSON.stringify(state)}`);
        lastKey = key;
      } else {
        console.log(`[monitor] unchanged ${state.appStoreState} @ ${state.checkedAt}`);
      }
      if (
        state.appStoreState === "READY_FOR_SALE" ||
        state.appVersionState === "READY_FOR_DISTRIBUTION"
      ) {
        console.log("[monitor] DONE — version is live.");
        break;
      }
    } catch (e) {
      console.error(`[monitor] probe error: ${e?.message || e}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
