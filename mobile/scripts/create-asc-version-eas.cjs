#!/usr/bin/env node
/** Create App Store version 1.1 if missing (minimal ASC API call). */
"use strict";
const path = require("path");
const { Platform } = require("@expo/eas-build-job");
const { createRequire } = require("module");
const mobileDir = path.resolve(__dirname, "..");
process.chdir(mobileDir);
const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));
const VERSION_STRING = process.env.VERSION_STRING || "1.1";

(async () => {
  const SessionManager = req("eas-cli/build/user/SessionManager").default;
  const LoggedInContextField = req("eas-cli/build/commandUtils/context/LoggedInContextField").default;
  const { PrivateProjectConfigContextField } = req("eas-cli/build/commandUtils/context/PrivateProjectConfigContextField");
  const VcsClientContextField = req("eas-cli/build/commandUtils/context/VcsClientContextField").default;
  const { CredentialsContext } = req("eas-cli/build/credentials/context");
  const { getProfilesAsync } = req("eas-cli/build/utils/profiles");
  const { EasJsonAccessor } = req("@expo/eas-json");
  const { getAppStoreAuthAsync } = req("eas-cli/build/metadata/auth");
  const { Platform: ApplePlatform } = req("@expo/apple-utils");
  const analytics = await req("eas-cli/build/analytics/AnalyticsManager").createAnalyticsAsync();
  const sessionManager = new SessionManager(analytics);
  const loggedIn = await new LoggedInContextField().getValueAsync({ nonInteractive: true, sessionManager });
  const projectConfig = await new PrivateProjectConfigContextField().getValueAsync({ nonInteractive: true, sessionManager, withServerSideEnvironment: null });
  const vcsClient = await new VcsClientContextField().getValueAsync({});
  const { exp, projectId, projectDir } = projectConfig;
  const submitProfiles = await getProfilesAsync({ type: "submit", easJsonAccessor: EasJsonAccessor.fromProjectPath(projectDir), platforms: [Platform.IOS], projectDir });
  const credentialsCtx = new CredentialsContext({ projectInfo: { exp, projectId }, projectDir, user: loggedIn.actor, graphqlClient: loggedIn.graphqlClient, analytics, nonInteractive: true, vcsClient });
  const { app } = await getAppStoreAuthAsync({ projectDir, profile: submitProfiles[0].profile, exp, credentialsCtx, nonInteractive: true, graphqlClient: loggedIn.graphqlClient, projectId });

  const versions = await app.getAppStoreVersionsAsync({ query: { limit: 10, filter: { platform: ApplePlatform.IOS } } });
  const existing = versions.find((v) => v.attributes.versionString === VERSION_STRING);
  if (existing) {
    console.log(`[asc] Version ${VERSION_STRING} already exists (${existing.id}) state=${existing.attributes.appStoreState}`);
    return;
  }
  const version = await app.createVersionAsync({ versionString: VERSION_STRING, platform: ApplePlatform.IOS });
  console.log(`[asc] Created version ${VERSION_STRING} id=${version.id}`);
})().catch((e) => {
  console.error("[asc] FAIL:", e?.message || e);
  process.exit(1);
});
