import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(process.env.MANAGER_TEST_RUNTIME
  ? path.join(process.env.MANAGER_TEST_RUNTIME, "package.json")
  : path.join(root, "package.json"));
const React = require("react");
const { act, create } = require("react-test-renderer");
const ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Compile the production provider and access helpers; substitute only native/network adapters.
function loadSource(filename, overrides, cache = new Map()) {
  const full = path.resolve(root, filename);
  if (cache.has(full)) return cache.get(full);
  const module = { exports: {} };
  cache.set(full, module.exports);
  const source = ts.transpileModule(readFileSync(full, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const localRequire = (name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name === "react") return React;
    if (name.startsWith(".")) {
      const resolved = path.resolve(path.dirname(full), name);
      return loadSource(path.relative(root, /\.[jt]sx?$/.test(resolved) ? resolved : `${resolved}.ts`), overrides, cache);
    }
    return require(name);
  };
  new Function("require", "module", "exports", source)(localRequire, module, module.exports);
  cache.set(full, module.exports);
  return module.exports;
}

const customer = { id: "user-a", role: "user", email: "manager@example.test", isManager: false };
const manager = {
  ...customer, isManager: true, managementRole: "shop_manager", managementStatus: "active",
  managementShopIds: [101], managerPermissions: { manage_appointments: true },
};
const ok = (user) => ({ ok: true, status: 200, json: { user } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function mount() {
  let stored = null;
  let session;
  let getMe = async () => ok(customer);
  const listeners = new Set();
  const nativeListeners = new Set();
  const intervals = new Map();
  let nextTimer = 1;
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => { const id = nextTimer++; intervals.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => intervals.delete(id);
  const appState = {
    currentState: "active",
    addEventListener: (_type, fn) => { nativeListeners.add(fn); return { remove: () => nativeListeners.delete(fn) }; },
  };
  const overrides = {
    "react-native": { AppState: appState },
    "../lib/supabase": { signOutSupabase: async () => {} },
    "./authService": {
      getAuthToken: async () => stored,
      setAuthToken: async (value) => { stored = value; for (const fn of listeners) fn(value); },
      subscribeAuthToken: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    "../auth/authSessionApi": { getAuthMe: (...args) => getMe(...args) },
    "./sessionApi": { refreshAuthSession: async () => ({ ok: false, reason: "invalid" }) },
    "../i18n": { applyPreferredLanguageFromUser: async () => {} },
  };
  const { AuthProvider, useAuth } = loadSource("mobile/services/authContext.tsx", overrides);
  function Probe() { session = useAuth(); return null; }
  let renderer;
  await act(async () => { renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe))); });
  return {
    get session() { return session; },
    get token() { return stored; },
    setMe(fn) { getMe = fn; },
    async foreground() { await act(async () => { for (const fn of nativeListeners) fn("active"); }); },
    async tick(state = "active") {
      appState.currentState = state;
      await act(async () => { for (const { fn, ms } of intervals.values()) { assert.equal(ms, 60_000); fn(); } });
    },
    async close() {
      await act(async () => renderer.unmount());
      assert.equal(nativeListeners.size, 0);
      assert.equal(intervals.size, 0);
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    },
  };
}

test("mobile preserves authenticated manager login payload when /me is temporarily unavailable", async () => {
  const h = await mount();
  try {
    h.setMe(async () => ({ ok: false, status: 0, json: {} }));
    await act(async () => h.session.signInWithToken("token-a", manager));
    assert.equal(h.session.hasStaffDashboard, true);
    assert.equal(h.session.staffRole, "manager");
    assert.deepEqual(h.session.user.managementShopIds, [101]);
    assert.equal(h.session.isPlatformAdmin, false);
  } finally { await h.close(); }
});

test("foreground refresh promotes an already signed-in customer and revokes suspended access", async () => {
  const h = await mount();
  try {
    await act(async () => h.session.signInWithToken("token-a", customer));
    assert.equal(h.session.hasStaffDashboard, false);
    h.setMe(async () => ok(manager));
    await h.foreground();
    assert.equal(h.session.hasStaffDashboard, true);
    h.setMe(async () => ok({ ...customer, managementStatus: "suspended" }));
    await h.foreground();
    assert.equal(h.session.hasStaffDashboard, false);
    assert.equal(h.session.isPlatformAdmin, false);
  } finally { await h.close(); }
});

test("active-app polling receives promotion; background polling does no network work", async () => {
  const h = await mount();
  try {
    await act(async () => h.session.signInWithToken("token-a", customer));
    let requests = 0;
    h.setMe(async () => { requests++; return ok(manager); });
    await h.tick("background");
    assert.equal(requests, 0);
    await h.tick();
    assert.equal(requests, 1);
    assert.equal(h.session.hasStaffDashboard, true);
  } finally { await h.close(); }
});

test("late refresh response cannot restore manager access after sign-out", async () => {
  const h = await mount();
  try {
    await act(async () => h.session.signInWithToken("token-a", customer));
    const pending = deferred();
    h.setMe(() => pending.promise);
    let refreshing;
    await act(async () => { refreshing = h.session.refresh(); });
    await act(async () => h.session.signOut());
    await act(async () => { pending.resolve(ok(manager)); await refreshing; });
    assert.equal(h.token, null);
    assert.equal(h.session.user, null);
    assert.equal(h.session.hasStaffDashboard, false);
  } finally { await h.close(); }
});

test("late account-A login response cannot replace account B", async () => {
  const h = await mount();
  try {
    const pending = deferred();
    h.setMe(() => pending.promise);
    let signingIn;
    await act(async () => { signingIn = h.session.signInWithToken("token-a", manager); });
    const other = { ...customer, id: "user-b", email: "other@example.test" };
    h.setMe(async () => ok(other));
    await act(async () => h.session.signInWithToken("token-b", other));
    await act(async () => { pending.resolve(ok(manager)); await signingIn; });
    assert.equal(h.token, "token-b");
    assert.equal(h.session.user.id, "user-b");
    assert.equal(h.session.hasStaffDashboard, false);
  } finally { await h.close(); }
});

test("definitively rejected login session clears login-provided manager details", async () => {
  const h = await mount();
  try {
    h.setMe(async () => ({ ok: false, status: 401, json: {} }));
    await act(async () => h.session.signInWithToken("token-a", manager));
    assert.equal(h.session.user, null);
    assert.equal(h.token, null);
  } finally { await h.close(); }
});

test("website replaces cached manager/admin flags after revocation", () => {
  const entries = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  } };
  try {
    const { persistAuthSession } = loadSource("client/src/lib/authHeaders.js", {
      "../config/adminClient.js": { ADMIN_KEY_STORAGE: "admin-key", getResolvedAdminApiKey: () => "" },
    });
    persistAuthSession({ token: "token-a", user: { ...customer, role: "admin" } });
    assert.equal(entries.get("ifcdc_logged_in"), "1");
    persistAuthSession({ token: "token-a", user: manager });
    assert.equal(entries.has("ifcdc_logged_in"), false);
    assert.equal(JSON.parse(entries.get("ifcdc_user")).isManager, true);
    persistAuthSession({ token: "token-a", user: customer });
    assert.equal(entries.has("ifcdc_user"), false);
    assert.equal(entries.has("ifcdc_logged_in"), false);
    assert.equal(JSON.parse(entries.get("user")).isManager, false);
  } finally { globalThis.window = previousWindow; }
});

test("website polls current assignments, renders promotion, and discards a response after sign-out", async () => {
  const entries = new Map([["token", "token-a"], ["user", JSON.stringify(customer)]]);
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const intervals = new Map();
  const listeners = new Map();
  const events = (prefix) => ({
    addEventListener: (type, fn) => listeners.set(`${prefix}:${type}`, fn),
    removeEventListener: (type) => listeners.delete(`${prefix}:${type}`),
  });
  globalThis.window = {
    ...events("window"),
    localStorage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    },
    setInterval: (fn, ms) => { assert.equal(ms, 60_000); intervals.set(1, fn); return 1; },
    clearInterval: (id) => intervals.delete(id),
  };
  globalThis.document = { ...events("document"), visibilityState: "visible" };
  let nextUser = customer;
  let pending = null;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (pending) return pending.promise;
    return { ok: true, status: 200, json: async () => ({ user: nextUser }) };
  };
  let renderer;
  try {
    const cache = new Map();
    const overrides = {
      "../config/adminClient.js": { ADMIN_KEY_STORAGE: "admin-key", getResolvedAdminApiKey: () => "" },
      "../services/api.js": { getApiOrigin: () => "https://api.example.test" },
    };
    const { default: Hydrate, useAuthSessionGeneration } = loadSource("client/src/components/AuthSessionHydrate.jsx", overrides, cache);
    const { clearAuthSession } = loadSource("client/src/lib/authHeaders.js", overrides, cache);
    const { hasStaffDashboardAccess } = loadSource("client/src/lib/staffDashboardAccess.js", overrides, cache);
    let displayedAccess;
    function Probe() {
      useAuthSessionGeneration();
      displayedAccess = hasStaffDashboardAccess(JSON.parse(entries.get("user") || "null"));
      return null;
    }
    await act(async () => { renderer = create(React.createElement(Hydrate, null, React.createElement(Probe))); });
    assert.equal(displayedAccess, false);
    nextUser = manager;
    await act(async () => { for (const tick of intervals.values()) tick(); });
    assert.equal(displayedAccess, true);
    nextUser = customer;
    await act(async () => { listeners.get("window:focus")(); });
    assert.equal(displayedAccess, false);
    globalThis.document.visibilityState = "hidden";
    const before = requests;
    await act(async () => { for (const tick of intervals.values()) tick(); });
    assert.equal(requests, before);
    globalThis.document.visibilityState = "visible";
    pending = deferred();
    await act(async () => { listeners.get("document:visibilitychange")(); });
    clearAuthSession();
    await act(async () => {
      pending.resolve({ ok: true, status: 200, json: async () => ({ user: manager }) });
    });
    assert.equal(entries.has("token"), false);
    assert.equal(entries.has("user"), false);
    await act(async () => renderer.unmount());
    renderer = null;
    assert.equal(intervals.size, 0);
    assert.equal(listeners.size, 0);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Object.assign(globalThis, previous);
  }
});
