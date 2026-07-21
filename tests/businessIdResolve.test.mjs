import assert from "node:assert/strict";
import {
  coerceNumericBusinessId,
  isLegacyDefaultTenant,
  resolveNumericBusinessId,
  clearDefaultShopBusinessIdCache,
} from "../businessIdResolve.js";

clearDefaultShopBusinessIdCache();
assert.equal(coerceNumericBusinessId("151"), 151);
assert.equal(coerceNumericBusinessId("0"), null);
assert.equal(coerceNumericBusinessId("default"), null);
assert.equal(isLegacyDefaultTenant("default"), true);
assert.equal(isLegacyDefaultTenant("0"), true);

const fakeDb = async (sql, params = []) => {
  if (/FROM businesses/i.test(sql) && /lower\(trim\(name\)\)/i.test(sql)) {
    assert.equal(params[0], "IFCDC Barbers");
    return { rows: [{ id: 1 }] };
  }
  if (/FROM businesses/i.test(sql) && /id = 1/i.test(sql)) {
    return { rows: [{ id: 1 }] };
  }
  return { rows: [] };
};

const resolved = await resolveNumericBusinessId("default", fakeDb);
assert.equal(resolved, 1);
const numeric = await resolveNumericBusinessId("203", fakeDb);
assert.equal(numeric, 203);

console.log("businessIdResolve tests passed");
