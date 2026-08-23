import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { customerEmailLabels, tLabel, normalizeLang } = require("../customerEmailI18n.cjs");

assert.equal(normalizeLang("es-MX"), "es");
assert.equal(normalizeLang("zh"), "zh-CN");
assert.equal(normalizeLang("xx-unknown"), "en");

const es = customerEmailLabels("es");
assert.match(tLabel(es, "reminderSubject"), /Recordatorio|cita/i);
assert.match(tLabel(es, "reviewCta"), /reseña|Dejar/i);
assert.match(tLabel(es, "loyaltySubject"), /lealtad|Actualización/i);

const missing = customerEmailLabels("zz");
assert.equal(tLabel(missing, "reminderSubject"), customerEmailLabels("en").reminderSubject);

const ar = customerEmailLabels("ar");
assert.ok(tLabel(ar, "cancelTitle").length > 0);
assert.notEqual(tLabel(ar, "cancelTitle"), "");

assert.equal(normalizeLang("he-IL"), "he");
const he = customerEmailLabels("he");
assert.match(tLabel(he, "cancelTitle"), /בוטל|ביטול/);
assert.match(tLabel(he, "reviewCta"), /ביקורת/);

console.log("customerEmailI18n tests passed");
