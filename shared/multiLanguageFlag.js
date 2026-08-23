/**
 * MULTI_LANGUAGE_DROPDOWN_V2 feature flag.
 *
 * Default: OFF. Enable with MULTI_LANGUAGE_DROPDOWN_V2=1|true|on|yes
 * for development / staging only until QA approval.
 */
export function envFlag(name, env = process.env) {
  const v = String(env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isMultiLanguageDropdownV2Enabled(env = process.env) {
  return envFlag("MULTI_LANGUAGE_DROPDOWN_V2", env);
}

/** Canonical supported language codes for V2. */
export const MULTI_LANGUAGE_CODES = Object.freeze([
  "en",
  "es",
  "fr",
  "ht",
  "pt",
  "ar",
  "he",
  "zh-CN",
  "ko",
  "vi",
]);

export const PHASE1_LANGUAGE_CODES = Object.freeze(["en", "es"]);

export function normalizePreferredLanguage(raw, { allowV2 = false } = {}) {
  if (!raw) return null;
  const allowed = allowV2 ? MULTI_LANGUAGE_CODES : PHASE1_LANGUAGE_CODES;
  let tag = String(raw).trim().replace(/_/g, "-");

  if (/^zh(-cn|-hans)?$/i.test(tag) || /^zh-hans$/i.test(tag)) {
    return allowed.includes("zh-CN") ? "zh-CN" : null;
  }

  const lower = tag.toLowerCase();
  const exact = allowed.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;

  const primary = lower.split("-")[0];
  if (primary === "zh" && allowed.includes("zh-CN")) return "zh-CN";
  if (allowed.includes(primary)) return primary;
  return null;
}
