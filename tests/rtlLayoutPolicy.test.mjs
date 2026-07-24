/**
 * RTL layout policy checks — mirrored-app regression guard.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const languagesSrc = readFileSync(join(root, "mobile/i18n/languages.ts"), "utf8");
const rtlSrc = readFileSync(join(root, "mobile/i18n/rtlLayout.ts"), "utf8");
const appSrc = readFileSync(join(root, "mobile/App.tsx"), "utf8");
const i18nSrc = readFileSync(join(root, "mobile/i18n/index.ts"), "utf8");

assert.match(languagesSrc, /code: "ar".*rtl: true/s);
assert.match(languagesSrc, /code: "en".*rtl: false/s);
assert.match(languagesSrc, /code: "es".*rtl: false/s);
assert.match(languagesSrc, /code: "fr".*rtl: false/s);

assert.match(rtlSrc, /forceNativeLtr/);
assert.match(rtlSrc, /allowRTL\(false\)/);
assert.match(rtlSrc, /forceRTL\(false\)/);
assert.match(rtlSrc, /EXPO_PUBLIC_ENABLE_NATIVE_RTL/);

assert.match(appSrc, /I18nManager\.allowRTL\(false\)/);
assert.match(appSrc, /I18nManager\.forceRTL\(false\)/);

assert.match(i18nSrc, /forceNativeLtr\(\)/);
assert.match(i18nSrc, /clearStickyRtlIfLtr/);

// Ensure we are not blindly forceRTL(true) on every language change without a gate.
assert.doesNotMatch(
  i18nSrc,
  /I18nManager\.forceRTL\(true\)/,
  "i18n/index.ts must not call forceRTL(true) directly",
);

console.log("rtlLayoutPolicy tests passed");
