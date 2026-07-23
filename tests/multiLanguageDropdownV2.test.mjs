/**
 * Locale parity + MULTI_LANGUAGE_DROPDOWN_V2 registry checks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isMultiLanguageDropdownV2Enabled,
  normalizePreferredLanguage,
  MULTI_LANGUAGE_CODES,
  PHASE1_LANGUAGE_CODES,
} from "../shared/multiLanguageFlag.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "mobile/i18n/locales");

function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

const en = JSON.parse(readFileSync(join(localesDir, "en.json"), "utf8"));
const enFlat = flatten(en);
assert.equal(Object.keys(enFlat).length, 289);

for (const code of ["es", "fr", "ht", "pt", "ar", "zh-CN", "ko", "vi"]) {
  const loc = JSON.parse(readFileSync(join(localesDir, `${code}.json`), "utf8"));
  const flat = flatten(loc);
  assert.equal(Object.keys(flat).length, 289, `${code} key count`);
  const missing = Object.keys(enFlat).filter((k) => !(k in flat));
  assert.equal(missing.length, 0, `${code} missing ${missing.slice(0, 5)}`);
}

assert.equal(isMultiLanguageDropdownV2Enabled({}), false);
assert.equal(isMultiLanguageDropdownV2Enabled({ MULTI_LANGUAGE_DROPDOWN_V2: "1" }), true);
assert.equal(normalizePreferredLanguage("es-MX", { allowV2: false }), "es");
assert.equal(normalizePreferredLanguage("zh-CN", { allowV2: true }), "zh-CN");
assert.equal(normalizePreferredLanguage("zh", { allowV2: true }), "zh-CN");
assert.equal(normalizePreferredLanguage("fr", { allowV2: false }), null);
assert.equal(normalizePreferredLanguage("fr", { allowV2: true }), "fr");
assert.deepEqual([...PHASE1_LANGUAGE_CODES], ["en", "es"]);
assert.equal(MULTI_LANGUAGE_CODES.length, 9);

console.log("multiLanguageDropdownV2 tests passed");
