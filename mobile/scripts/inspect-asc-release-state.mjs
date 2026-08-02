#!/usr/bin/env node
/**
 * Read-only App Store Connect release probe (EAS ASC key auth).
 * Usage from mobile/: node scripts/inspect-asc-release-state.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, "..");
const require = createRequire(path.join(mobileRoot, "package.json"));

const appJson = JSON.parse(fs.readFileSync(path.join(mobileRoot, "app.json"), "utf8"));
const store = JSON.parse(fs.readFileSync(path.join(mobileRoot, "store.config.json"), "utf8"));
const VERSION_STRING = String(process.env.APP_VERSION || appJson.expo?.version || "1.1.9");
const BUILD_NUMBER = String(process.env.APP_BUILD_NUMBER || appJson.expo?.ios?.buildNumber || "73");
const BUNDLE_ID = String(appJson.expo?.ios?.bundleIdentifier || "com.ifcdc.barbers");
const PROJECT_ID = String(appJson.expo?.extra?.eas?.projectId || "");
const ACCOUNT = "ifcdc696";
const SLUG = String(appJson.expo?.slug || "ifcdc-barbers-backend");

const apple = require("@expo/apple-utils");
const { SessionManager } = require("eas-cli/build/user/SessionManager.js");
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

const analytics = { setActor() {}, logEvent() {} };

function clip(s, n = 160) {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function main() {
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

  const ascKeyFragment = await getAscApiKeyForAppSubmissionsAsync(graphqlClient, {
    account,
    projectName: SLUG,
    bundleIdentifier: BUNDLE_ID,
  });
  if (!ascKeyFragment?.id) throw new Error("No ASC API key in EAS credentials.");
  const fullKey = await AppStoreConnectApiKeyQuery.getByIdAsync(graphqlClient, ascKeyFragment.id);
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
  if (!app) throw new Error(`App not found for ${BUNDLE_ID}`);

  const versions = await app.getAppStoreVersionsAsync({
    query: { limit: 12, filter: { platform: apple.Platform.IOS } },
  });
  const versionRows = [];
  for (const v of versions || []) {
    let buildInfo = null;
    try {
      const b = await v.getBuildAsync();
      buildInfo = b
        ? {
            id: b.id,
            version: b.attributes?.version,
            processingState: b.attributes?.processingState,
            expired: b.attributes?.expired,
          }
        : null;
    } catch {
      buildInfo = null;
    }
    versionRows.push({
      id: v.id,
      versionString: v.attributes?.versionString,
      appStoreState: v.attributes?.appStoreState,
      appVersionState: v.attributes?.appVersionState,
      releaseType: v.attributes?.releaseType,
      earliestReleaseDate: v.attributes?.earliestReleaseDate,
      build: buildInfo,
    });
  }

  const target =
    versionRows.find((v) => v.versionString === VERSION_STRING) ||
    versionRows.find((v) => String(v.appStoreState || "").includes("PREPARE") || String(v.appStoreState || "").includes("WAITING") || String(v.appStoreState || "").includes("REVIEW") || String(v.appStoreState || "").includes("PENDING")) ||
    versionRows[0];

  let localization = null;
  let screenshots = { iphone65: 0, ipad129: 0 };
  let reviewDetail = null;
  let privacy = null;
  if (target) {
    const versionObj = (versions || []).find((v) => v.id === target.id);
    if (versionObj) {
      const locs = await versionObj.getLocalizationsAsync();
      const en = (locs || []).find((l) => l.attributes?.locale === "en-US") || locs?.[0];
      if (en) {
        localization = {
          locale: en.attributes?.locale,
          title: en.attributes?.title,
          subtitle: en.attributes?.subtitle,
          descriptionLen: String(en.attributes?.description || "").length,
          keywords: en.attributes?.keywords,
          supportUrl: en.attributes?.supportUrl,
          marketingUrl: en.attributes?.marketingUrl,
          privacyPolicyUrl: en.attributes?.privacyPolicyUrl,
          whatsNew: clip(en.attributes?.whatsNew, 220),
        };
        try {
          const sets = await en.getScreenshotSetsAsync?.();
          for (const set of sets || []) {
            const dt = set.attributes?.screenshotDisplayType;
            const shots = await set.getScreenshotsAsync?.();
            const n = Array.isArray(shots) ? shots.length : shots?.data?.length || 0;
            if (String(dt).includes("IPHONE_65") || String(dt).includes("APP_IPHONE_65")) screenshots.iphone65 = n;
            if (String(dt).includes("IPAD_PRO") || String(dt).includes("129")) screenshots.ipad129 = n;
          }
        } catch (e) {
          screenshots.error = e?.message || String(e);
        }
      }
      try {
        const rd = await versionObj.getAppStoreReviewDetailAsync();
        reviewDetail = {
          demoAccountRequired: rd?.attributes?.demoAccountRequired,
          demoAccountName: rd?.attributes?.demoAccountName,
          demoPasswordSet: Boolean(rd?.attributes?.demoAccountPassword),
          contactEmail: rd?.attributes?.contactEmail,
          notesLen: String(rd?.attributes?.notes || "").length,
          notesHead: clip(rd?.attributes?.notes, 120),
        };
      } catch (e) {
        reviewDetail = { error: e?.message || String(e) };
      }
    }
  }

  try {
    // Privacy nutrition labels live on app; best-effort
    const decls = await app.getAppPrivacyDetailsAsync?.();
    privacy = decls ? { present: true } : { present: false };
  } catch (e) {
    privacy = { error: e?.message || String(e) };
  }

  let builds73 = await app.getBuildsAsync({
    filter: { version: BUILD_NUMBER, processingState: "VALID,PROCESSING,UPLOADING,FAILED,INVALID" },
  });
  if (!Array.isArray(builds73)) builds73 = builds73?.data || [];

  const inProgress = await app.getInProgressReviewSubmissionAsync({ platform: apple.Platform.IOS }).catch(() => null);
  const ready = await app.getReadyReviewSubmissionAsync({ platform: apple.Platform.IOS }).catch(() => null);
  const subs = await app.getReviewSubmissionsAsync({
    query: { limit: 8, filter: { platform: apple.Platform.IOS } },
  }).catch(() => []);

  const out = {
    ok: true,
    expected: {
      versionString: VERSION_STRING,
      buildNumber: BUILD_NUMBER,
      releaseNotesLocal: clip(store?.apple?.info?.["en-US"]?.releaseNotes, 180),
      privacyPolicyUrlLocal: store?.apple?.info?.["en-US"]?.privacyPolicyUrl,
      automaticRelease: store?.apple?.release?.automaticRelease,
    },
    appId: app.id,
    versions: versionRows,
    targetVersion: target || null,
    localization,
    screenshots,
    reviewDetail,
    privacy,
    buildsForTargetNumber: (builds73 || []).map((b) => ({
      id: b.id,
      version: b.attributes?.version,
      processingState: b.attributes?.processingState,
      uploadedDate: b.attributes?.uploadedDate,
      expired: b.attributes?.expired,
    })),
    reviewSubmissions: {
      inProgress: inProgress
        ? { id: inProgress.id, state: inProgress.attributes?.state }
        : null,
      ready: ready ? { id: ready.id, state: ready.attributes?.state } : null,
      recent: (subs || []).map((s) => ({ id: s.id, state: s.attributes?.state })),
    },
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("[asc-inspect] FAIL:", e?.message || e);
  if (e?.stack) console.error(e.stack.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
});
