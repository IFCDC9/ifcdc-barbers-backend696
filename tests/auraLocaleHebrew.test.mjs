/**
 * AURA recognizes Hebrew as the customer's selected UI language.
 */
import assert from "node:assert/strict";
import {
  detectClientLanguage,
  openAiLanguageInstruction,
  normalizeAuraClientLang,
  normalizeBarberLang,
  resolveAuraLanguage,
} from "../auraLocale.js";

assert.equal(normalizeAuraClientLang("he"), "he");
assert.equal(normalizeAuraClientLang("he-IL"), "he");
assert.equal(normalizeAuraClientLang("iw"), "he");
assert.equal(normalizeBarberLang("he"), "en"); // barber packs stay en|es

const req = {
  body: { language: "he" },
  get: () => undefined,
};
assert.equal(detectClientLanguage(req), "he");
assert.equal(resolveAuraLanguage(req, "es"), "he");
assert.match(openAiLanguageInstruction("he"), /Hebrew|עברית/);
assert.match(openAiLanguageInstruction("es"), /Spanish/);

console.log("auraLocaleHebrew tests passed");
