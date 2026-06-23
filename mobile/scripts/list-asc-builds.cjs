#!/usr/bin/env node
"use strict";
/** List ASC builds and version 1.0 attachment state. */
const path = require("path");
const { Platform } = require("@expo/eas-build-job");
const { createRequire } = require("module");
const mobileDir = path.resolve(__dirname, "..");
process.chdir(mobileDir);
const req = createRequire(path.join(mobileDir, "node_modules/eas-cli/package.json"));

(async () => {
  const { createAnalyticsAsync } = req("eas-cli/build/analytics/AnalyticsManager");
  const SessionManager = req("eas-cli/build/user/SessionManager").default;
  const LoggedInContextField = req("eas-cli/build/commandUtils/context/LoggedInContextField").default;
  const { PrivateProjectConfigContextField } = req("eas-cli/build/commandUtils/context/PrivateProjectConfigContextField");
  const VcsClientContextField = req("eas-cli/build/commandUtils/context/VcsClientContextField").default;
  const { CredentialsContext } = req("eas-cli/build/credentials/context");
  const { getProfilesAsync } = req("eas-cli/build/utils/profiles");
  const { EasJsonAccessor } = req("@expo/eas-json");
  const { getAppStoreAuthAsync } = req("eas-cli/build/metadata/auth");
  const { Platform: ApplePlatform } = req("@expo/apple-utils");

  const analytics = await createAnalyticsAsync();
  const sessionManager = new SessionManager(analytics);
  const loggedIn = await new LoggedInContextField().getValueAsync({ nonInteractive: true, sessionManager });
  const projectConfig = await new PrivateProjectConfigContextField().getValueAsync({ nonInteractive: true, sessionManager, withServerSideEnvironment: null });
  const vcsClient = await new VcsClientContextField().getValueAsync({});
  const { exp, projectId, projectDir } = projectConfig;
  const submitProfiles = await getProfilesAsync({ type: "submit", easJsonAccessor: EasJsonAccessor.fromProjectPath(projectDir), platforms: [Platform.IOS], projectDir });
  const credentialsCtx = new CredentialsContext({ projectInfo: { exp, projectId }, projectDir, user: loggedIn.actor, graphqlClient: loggedIn.graphqlClient, analytics, nonInteractive: true, vcsClient });
  const { app } = await getAppStoreAuthAsync({ projectDir, profile: submitProfiles[0].profile, exp, credentialsCtx, nonInteractive: true, graphqlClient: loggedIn.graphqlClient, projectId });

  const builds = await app.getBuildsAsync({ query: { limit: 15 } });
  console.log("=== ASC builds (newest first) ===");
  for (const b of builds) {
    console.log(
      `build ${b.attributes.version} id=${b.id} state=${b.attributes.processingState} expired=${b.attributes.expired}`,
    );
  }

  const version = (await app.getAppStoreVersionsAsync({ query: { limit: 10, filter: { platform: ApplePlatform.IOS } } })).find((v) => v.attributes.versionString === "1.0");
  console.log("\n=== Version 1.0 ===");
  console.log("state", version.attributes.appStoreState, version.attributes.appVersionState);
  const attached = await version.getBuildAsync();
  console.log(
    "attached",
    attached ? `${attached.attributes.version} (${attached.id}) ${attached.attributes.processingState}` : "(none)",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
