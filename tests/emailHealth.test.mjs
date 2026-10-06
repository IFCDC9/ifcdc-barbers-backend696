/**
 * Email health booleans. Fixture token stays in this process. No network.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const FIXTURE = "zzPMREADINESSFIXTURE9Q7K2M4W";

test("email health reports Postmark readiness without exposing the token", () => {
  const previous = process.env.POSTMARK_SERVER_TOKEN;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args[0]);
    throw new Error("network_not_allowed");
  };
  try {
    const { postmarkReadiness } = require("../emailHealth.cjs");
    process.env.POSTMARK_SERVER_TOKEN = FIXTURE;
    const on = postmarkReadiness();
    assert.equal(on.postmarkConfigured, true);
    assert.equal(on.postmarkTransportReady, true);
    const serialized = JSON.stringify(on);
    assert.equal(serialized.includes(FIXTURE), false);
    assert.equal(serialized.includes(String(FIXTURE.length)), false);
    assert.equal(serialized.includes(createHash("sha256").update(FIXTURE).digest("hex")), false);
    for (let i = 0; i <= FIXTURE.length - 6; i += 1) {
      assert.equal(serialized.includes(FIXTURE.slice(i, i + 6)), false);
    }
    assert.deepEqual(Object.keys(on).sort(), ["postmarkConfigured", "postmarkTransportReady"]);

    process.env.POSTMARK_SERVER_TOKEN = "   ";
    const blank = postmarkReadiness();
    assert.equal(blank.postmarkConfigured, false);
    assert.equal(blank.postmarkTransportReady, false);

    delete process.env.POSTMARK_SERVER_TOKEN;
    const off = postmarkReadiness();
    assert.equal(off.postmarkConfigured, false);
    assert.equal(off.postmarkTransportReady, false);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous == null) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = previous;
  }
});
