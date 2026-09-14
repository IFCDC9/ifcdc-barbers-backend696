/**
 * Guard: Profile tab must resolve ProfileHomeScreen (TestFlight ReferenceError).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stackPath = join(root, "mobile/navigation/ProfileStack.tsx");
const homePath = join(root, "mobile/screens/profile/ProfileHomeScreen.tsx");
const tabsPath = join(root, "mobile/navigation/HomeTabs.tsx");
const profileTabPath = join(root, "mobile/app/(tabs)/profile.tsx");
const loginPath = join(root, "mobile/screens/LoginScreen.tsx");
const subPath = join(root, "mobile/screens/profile/SubscriptionScreen.tsx");
const staffPath = join(root, "mobile/utils/staffDashboardAccess.ts");

function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^import\s+(\w+)\s+from/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^import\s+\{\s*([^}]+)\s*\}/gm)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n) names.add(n);
    }
  }
  return names;
}

test("ProfileStack imports ProfileHomeScreen and every component={...} screen", () => {
  const src = readFileSync(stackPath, "utf8");
  const names = importedNames(src);
  assert.ok(names.has("ProfileHomeScreen"), "ProfileStack must import ProfileHomeScreen");
  assert.match(src, /from ["']\.\.\/screens\/profile\/ProfileHomeScreen["']/);
  assert.match(src, /name=["']ProfileHome["']\s+component=\{ProfileHomeScreen\}/);

  const used = [...src.matchAll(/component=\{([A-Z]\w*)\}/g)].map((m) => m[1]);
  const missing = used.filter((name) => !names.has(name));
  assert.deepEqual(missing, [], `unresolved ProfileStack components: ${missing.join(", ")}`);
});

test("ProfileHomeScreen exists, is the stack root, and is not a Feature unavailable stub", () => {
  const home = readFileSync(homePath, "utf8");
  const stack = readFileSync(stackPath, "utf8");
  assert.match(home, /export default function ProfileHomeScreen/);
  assert.doesNotMatch(home, /Feature unavailable/);
  assert.doesNotMatch(stack, /Feature unavailable/);
  assert.match(home, /key: ["']Subscription["']/);
  assert.match(home, /signOut/);
  assert.match(home, /role === ["']barber["']/);
  assert.match(home, /role === ["']shop_owner["']/);
  assert.match(home, /key: ["']ShopRoster["']/);
  assert.match(home, /key: ["']ProviderSchedule["']/);
});

test("every ProfileHomeScreen identifier resolves to the screen module or its default export", () => {
  const stack = readFileSync(stackPath, "utf8");
  const home = readFileSync(homePath, "utf8");
  const hits = [];
  for (const rel of [
    "mobile/navigation/ProfileStack.tsx",
    "mobile/screens/profile/ProfileHomeScreen.tsx",
  ]) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/ProfileHomeScreen/g)) hits.push(rel);
  }
  assert.ok(hits.length >= 3);
  assert.match(stack, /import ProfileHomeScreen from/);
  assert.match(home, /export default function ProfileHomeScreen/);
});

test("Profile tab wiring: HomeTabs -> profile.tsx -> ProfileStack for all roles", () => {
  const tabs = readFileSync(tabsPath, "utf8");
  const profileTab = readFileSync(profileTabPath, "utf8");
  const staff = readFileSync(staffPath, "utf8");
  assert.match(tabs, /PROFILE_LOADER: Loader = \(\) => require\(["']\.\.\/app\/\(tabs\)\/profile["']\)/);
  assert.match(tabs, /name=["']Profile["']\s+component=\{ProfileTabScreen\}/);
  assert.match(profileTab, /export \{ default \} from ["']\.\.\/\.\.\/navigation\/ProfileStack["']/);
  // Role vs subscription: Profile is always a tab; staff dashboards are a separate Admin tab.
  assert.match(tabs, /hasStaffDashboard/);
  assert.match(staff, /platform_manager/);
  assert.match(staff, /shop_manager/);
  assert.match(staff, /hasStaffDashboardAccess/);
  assert.match(staff, /role === ["']super_admin["']/);
  assert.match(staff, /role === ["']shop_owner["']/);
});

test("Subscription section and Apple Sign In remain wired", () => {
  const stack = readFileSync(stackPath, "utf8");
  const sub = readFileSync(subPath, "utf8");
  const login = readFileSync(loginPath, "utf8");
  assert.match(stack, /name=["']Subscription["']\s+component=\{SubscriptionScreen\}/);
  assert.match(stack, /name=["']ShopSubscription["']\s+component=\{SubscriptionScreen\}/);
  assert.match(sub, /Role is not a plan/);
  assert.match(login, /AppleSignInButton|expo-apple-authentication|signInWithApple/);
});

test("verify-profile-stack-imports.cjs exits 0", () => {
  const r = spawnSync(process.execPath, [join(root, "mobile/scripts/verify-profile-stack-imports.cjs")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /OK/);
});
