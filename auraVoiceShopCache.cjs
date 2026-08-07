/**
 * Short-lived in-memory cache for safe AURA voice lookups (hours / barbers).
 * Reduces repeated DB hits within a call window. Does not cache bookings or payments.
 */
const DEFAULT_TTL_MS = Math.max(
  5_000,
  Math.min(120_000, Number(process.env.AURA_VOICE_CACHE_TTL_MS || 45_000) || 45_000),
);

const store = new Map();
const CAP = 500;

function prune() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (!v || v.expiresAt <= now) store.delete(k);
  }
  while (store.size > CAP) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
}

function cacheKey(kind, shopId) {
  return `${kind}:${shopId == null ? "_" : String(shopId)}`;
}

function getCached(kind, shopId) {
  prune();
  const hit = store.get(cacheKey(kind, shopId));
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit.value;
}

function setCached(kind, shopId, value, ttlMs = DEFAULT_TTL_MS) {
  prune();
  store.set(cacheKey(kind, shopId), {
    value,
    expiresAt: Date.now() + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
  });
  return value;
}

async function cachedLookup(kind, shopId, loader, ttlMs = DEFAULT_TTL_MS) {
  const existing = getCached(kind, shopId);
  if (existing !== null && existing !== undefined) {
    return { value: existing, cacheHit: true };
  }
  const value = await loader();
  if (value !== null && value !== undefined) {
    setCached(kind, shopId, value, ttlMs);
  }
  return { value, cacheHit: false };
}

function clearVoiceShopCache() {
  store.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  getCached,
  setCached,
  cachedLookup,
  clearVoiceShopCache,
};
