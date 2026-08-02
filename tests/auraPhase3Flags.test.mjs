import assert from "node:assert/strict";
import { createRequire } from "module";
import { test, beforeEach, afterEach } from "node:test";

const require = createRequire(import.meta.url);

const FLAG_KEYS = [
  "AURA_PHASE3_ENABLED",
  "AURA_PHASE3_KNOWLEDGE",
  "AURA_PHASE3_CONVERSATION",
  "AURA_PHASE3_CUSTOMER_PREFERENCES",
  "AURA_PHASE3_PREFERENCE_SUGGESTIONS",
  "AURA_PHASE3_WAITLIST",
  "AURA_PHASE3_SLOT_RECOVERY",
  "AURA_PHASE3_WAITLIST_NOTIFICATIONS",
  "AURA_PHASE3_OPERATIONAL_INSIGHTS",
];

const saved = {};

beforeEach(() => {
  for (const k of FLAG_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of FLAG_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("Phase 3 flags default off", () => {
  const { auraPhase3Flags, isAuraPhase3Enabled } = require("../auraPhase3Flags.cjs");
  assert.equal(isAuraPhase3Enabled(), false);
  const f = auraPhase3Flags();
  assert.equal(f.master, false);
  assert.equal(f.knowledge, false);
  assert.equal(f.conversation, false);
  assert.equal(f.customerPreferences, false);
  assert.equal(f.preferenceSuggestions, false);
  assert.equal(f.waitlist, false);
  assert.equal(f.slotRecovery, false);
  assert.equal(f.waitlistNotifications, false);
  assert.equal(f.operationalInsights, false);
});

test("Phase 3 subflags require master", () => {
  process.env.AURA_PHASE3_KNOWLEDGE = "1";
  process.env.AURA_PHASE3_WAITLIST = "1";
  process.env.AURA_PHASE3_CUSTOMER_PREFERENCES = "1";
  process.env.AURA_PHASE3_PREFERENCE_SUGGESTIONS = "1";
  process.env.AURA_PHASE3_SLOT_RECOVERY = "1";
  process.env.AURA_PHASE3_WAITLIST_NOTIFICATIONS = "1";
  const { auraPhase3Flags } = require("../auraPhase3Flags.cjs");
  assert.equal(auraPhase3Flags().knowledge, false);
  assert.equal(auraPhase3Flags().waitlist, false);
  assert.equal(auraPhase3Flags().customerPreferences, false);
  assert.equal(auraPhase3Flags().preferenceSuggestions, false);
  assert.equal(auraPhase3Flags().slotRecovery, false);
  assert.equal(auraPhase3Flags().waitlistNotifications, false);

  process.env.AURA_PHASE3_ENABLED = "1";
  const on = auraPhase3Flags();
  assert.equal(on.master, true);
  assert.equal(on.knowledge, true);
  assert.equal(on.waitlist, true);
  assert.equal(on.customerPreferences, true);
  assert.equal(on.preferenceSuggestions, true);
  assert.equal(on.slotRecovery, true);
  assert.equal(on.waitlistNotifications, true);
});
