#!/usr/bin/env node
"use strict";
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

  const version = (await app.getAppStoreVersionsAsync({ query: { limit: 10, filter: { platform: ApplePlatform.IOS } } })).find((v) => v.attributes.versionString === "1.0");
  console.log("version", version.id, version.attributes.appStoreState, version.attributes.appVersionState);

  const locs = await version.getLocalizationsAsync();
  for (const loc of locs) {
    console.log("locale", loc.attributes.locale, "whatsNew", (loc.attributes.whatsNew || "").slice(0, 120));
  }

  const rd = await version.getAppStoreReviewDetailAsync();
  console.log(
    "review",
    JSON.stringify(
      {
        demoAccountRequired: rd.attributes.demoAccountRequired,
        demoAccountName: rd.attributes.demoAccountName,
        demoPasswordSet: Boolean(rd.attributes.demoAccountPassword),
        notesLen: String(rd.attributes.notes || "").length,
      },
      null,
      2,
    ),
  );

  const rs = await app.getInProgressReviewSubmissionAsync({ platform: ApplePlatform.IOS });
  console.log("inProgressSubmission", rs?.id, rs?.attributes?.state);

  const subs = await app.getReviewSubmissionsAsync({
    query: { limit: 10, filter: { platform: ApplePlatform.IOS } },
  });
  for (const s of subs) console.log("submission", s.id, s.attributes.state);

  const build = await version.getBuildAsync();
  console.log("build", build?.id, build?.attributes?.processingState, build?.attributes?.expired);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
