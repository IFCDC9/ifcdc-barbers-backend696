#!/usr/bin/env node
/**
 * Enable Sign in with Apple on the App ID and regenerate the App Store provisioning profile
 * using EAS-stored App Store Connect API credentials (non-interactive).
 *
 * Usage (from repo root):
 *   node mobile/scripts/sync-ios-apple-signin-credentials-eas.cjs
 */
"use strict";

const path = require("path");
const { Platform } = require("@expo/eas-build-job");
const { createRequire } = require("module");

const mobileDir = path.resolve(__dirname, "..");
process.chdir(mobileDir);

const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));

const BUILD_PROFILE = "production";
const BUNDLE_ID = "com.ifcdc.barbers";

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
  const { getOwnerAccountForProjectIdAsync } = req("eas-cli/build/project/projectUtils");
  const { resolveXcodeBuildContextAsync } = req("eas-cli/build/project/ios/scheme");
  const { resolveTargetsAsync } = req("eas-cli/build/project/ios/target");
  const { AuthenticationMode, AppleTeamType } = req(
    "eas-cli/build/credentials/ios/appstore/authenticateTypes",
  );
  const { getAscApiKeyForAppSubmissionsAsync } = req("eas-cli/build/credentials/ios/api/GraphqlClient");
  const { AppStoreConnectApiKeyQuery } = req("eas-cli/build/graphql/queries/AppStoreConnectApiKeyQuery");
  const { SetUpBuildCredentials } = req("eas-cli/build/credentials/ios/actions/SetUpBuildCredentials");
  const { getProvisioningProfileAsync } = req("eas-cli/build/credentials/ios/actions/BuildCredentialsUtils");
  const { RemoveProvisioningProfiles } = req("eas-cli/build/credentials/ios/actions/RemoveProvisioningProfile");
  const { ConfigureProvisioningProfile } = req("eas-cli/build/credentials/ios/actions/ConfigureProvisioningProfile");
  const { getDistributionCertificateAsync } = req("eas-cli/build/credentials/ios/actions/BuildCredentialsUtils");
  const { revokeProvisioningProfileAsync } = req("eas-cli/build/credentials/ios/appstore/provisioningProfile");
  const { ApplePlatform } = req("eas-cli/build/credentials/ios/appstore/constants");
  const { authenticateAsync, getRequestContext } = req("eas-cli/build/credentials/ios/appstore/authenticate");
  const { BundleId } = req("@expo/apple-utils");
  const { parse: parseProvisioningProfile } = req("eas-cli/build/credentials/ios/utils/provisioningProfile");
  const { IosDistributionType } = req("eas-cli/build/graphql/generated");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const APPLE_DEVELOPER_BUNDLE_URL =
    "https://developer.apple.com/account/resources/identifiers/bundleId/edit/SY9B9V5RNU";

  async function assertAppleSignInEnabledOnBundle(authCtx) {
    const context = getRequestContext(authCtx);
    const bundleId = await BundleId.findAsync(context, { identifier: BUNDLE_ID });
    const caps = await bundleId.getBundleIdCapabilitiesAsync();
    const types = caps.map((c) => c.attributes?.capabilityType || c.id.replace(`${bundleId.id}_`, ""));
    if (!types.includes("APPLE_ID_AUTH")) {
      throw new Error(
        `Sign in with Apple is not enabled on App ID ${BUNDLE_ID}.\n` +
          `The ASC API key cannot enable this capability — enable it manually in Apple Developer, then re-run this script:\n` +
          `  ${APPLE_DEVELOPER_BUNDLE_URL}\n` +
          `  Capabilities → Sign in with Apple → Save → Confirm`,
      );
    }
    console.log("[ios] Verified APPLE_ID_AUTH capability on bundle identifier");
  }

  async function assertProfileIncludesAppleSignIn(credentialsCtx, appWithBundle) {
    const profile = await getProvisioningProfileAsync(
      credentialsCtx,
      appWithBundle,
      IosDistributionType.AppStore,
    );
    if (!profile?.provisioningProfile) {
      throw new Error("Provisioning profile missing after sync — re-run this script.");
    }
    const plist = parseProvisioningProfile(Buffer.from(profile.provisioningProfile, "base64"));
    const entitlements = plist.Entitlements || {};
    if (!entitlements["com.apple.developer.applesignin"]) {
      throw new Error(
        `Provisioning profile ${profile.developerPortalIdentifier} still lacks com.apple.developer.applesignin.\n` +
          `Enable Sign in with Apple on the App ID in Apple Developer (link above), wait ~1 minute, then re-run this script.`,
      );
    }
    console.log("[ios] Verified provisioning profile includes Sign in with Apple entitlement");
  }

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

  const buildProfiles = await getProfilesAsync({
    type: "build",
    easJsonAccessor: EasJsonAccessor.fromProjectPath(projectDir),
    platforms: [Platform.IOS],
    profileName: BUILD_PROFILE,
    projectDir,
  });
  if (buildProfiles.length !== 1) {
    throw new Error(`Expected exactly one iOS build profile named ${BUILD_PROFILE}`);
  }
  const buildProfile = buildProfiles[0].profile;

  const credentialsCtx = new CredentialsContext({
    projectInfo: { exp, projectId },
    projectDir,
    user: loggedIn.actor,
    graphqlClient: loggedIn.graphqlClient,
    analytics,
    nonInteractive: true,
    autoAcceptCredentialReuse: true,
    vcsClient,
  });
  credentialsCtx.shouldAskAuthenticateAppStore = false;

  const account = await getOwnerAccountForProjectIdAsync(loggedIn.graphqlClient, projectId);
  const appLookupParams = {
    account,
    projectName: exp.slug,
    bundleIdentifier: BUNDLE_ID,
  };

  const ascKeyFragment = await getAscApiKeyForAppSubmissionsAsync(
    loggedIn.graphqlClient,
    appLookupParams,
  );
  if (!ascKeyFragment) {
    throw new Error(
      "No App Store Connect API key found in EAS credentials. Run `eas credentials` to add one.",
    );
  }

  const fullKey = await AppStoreConnectApiKeyQuery.getByIdAsync(
    loggedIn.graphqlClient,
    ascKeyFragment.id,
  );
  const teamId = ascKeyFragment.appleTeam?.appleTeamIdentifier || "KTP587XA2T";

  console.log(`[ios] Authenticating with ASC API key ${fullKey.keyIdentifier} (team ${teamId})`);
  credentialsCtx.appStore.defaultAuthenticationMode = AuthenticationMode.API_KEY;
  await credentialsCtx.appStore.ensureAuthenticatedAsync({
    mode: AuthenticationMode.API_KEY,
    ascApiKey: {
      keyP8: fullKey.keyP8,
      keyId: fullKey.keyIdentifier,
      issuerId: fullKey.issuerIdentifier,
    },
    teamId,
    teamType: AppleTeamType.COMPANY_OR_ORGANIZATION,
  });

  await assertAppleSignInEnabledOnBundle(credentialsCtx.appStore.authCtx);

  const xcodeBuildContext = await resolveXcodeBuildContextAsync(
    { projectDir, nonInteractive: true, exp, vcsClient },
    buildProfile,
  );
  const targets = await resolveTargetsAsync({
    exp,
    projectDir,
    xcodeBuildContext,
    env: buildProfile.env,
    vcsClient,
  });

  const app = { account, projectName: exp.slug };
  const appWithBundle = { ...app, bundleIdentifier: BUNDLE_ID };

  console.log("[ios] Revoking App Store profiles on Apple Developer Portal…");
  await revokeProvisioningProfileAsync(
    credentialsCtx.appStore.authCtx,
    BUNDLE_ID,
    ApplePlatform.IOS,
  );

  const oldProfile = await getProvisioningProfileAsync(
    credentialsCtx,
    appWithBundle,
    IosDistributionType.AppStore,
  );
  if (oldProfile) {
    console.log(`[ios] Removing stale App Store provisioning profile ${oldProfile.id}`);
    await new RemoveProvisioningProfiles([appWithBundle], [oldProfile]).runAsync(credentialsCtx);
  } else {
    console.log("[ios] No existing App Store provisioning profile on EAS — creating fresh");
  }

  console.log("[ios] Waiting for Apple capability propagation…");
  await sleep(12_000);

  console.log("[ios] Syncing Sign in with Apple capability and regenerating provisioning profile…");
  await new SetUpBuildCredentials({
    app,
    targets,
    distribution: buildProfile.distribution,
    enterpriseProvisioning: buildProfile.enterpriseProvisioning,
  }).runAsync(credentialsCtx);

  const target = targets[0];
  const distCert = await getDistributionCertificateAsync(
    credentialsCtx,
    appWithBundle,
    IosDistributionType.AppStore,
  );
  const newProfile = await getProvisioningProfileAsync(
    credentialsCtx,
    appWithBundle,
    IosDistributionType.AppStore,
  );
  if (distCert && newProfile) {
    console.log("[ios] Regenerating provisioning profile to include Sign in with Apple entitlement…");
    await new ConfigureProvisioningProfile(
      appWithBundle,
      target,
      distCert,
      newProfile,
    ).runAsync(credentialsCtx);
  }

  await assertProfileIncludesAppleSignIn(credentialsCtx, appWithBundle);

  console.log("[ios] SUCCESS — credentials ready for Build 36 with Sign in with Apple.");
}

main().catch((e) => {
  console.error("[ios] FAIL:", e?.message || e);
  process.exit(1);
});
