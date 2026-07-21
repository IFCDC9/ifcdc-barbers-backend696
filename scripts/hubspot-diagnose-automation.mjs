#!/usr/bin/env node
/**
 * Live HubSpot automation diagnostic (never prints HUBSPOT_SERVICE_KEY).
 *
 *   HUBSPOT_SERVICE_KEY=… node --import ./loadBackendEnv.mjs scripts/hubspot-diagnose-automation.mjs
 *
 * Or rely on Render's env after deploy:
 *   curl -sS 'https://ifcdc-barbers-backend696.onrender.com/api/hubspot/status?refreshSetup=1'
 */
import { createHash } from "crypto";

const API = "https://api.hubapi.com";
const key = String(process.env.HUBSPOT_SERVICE_KEY || "").trim();
if (!key) {
  console.error(
    "Missing HUBSPOT_SERVICE_KEY.\n" +
      "Export the SAME value currently on Render canonical (do not paste into chat),\n" +
      "then re-run this script.",
  );
  process.exit(1);
}

const fingerprint = {
  sha256_12: createHash("sha256").update(key).digest("hex").slice(0, 12),
  length: key.length,
  prefix: key.slice(0, 7),
  format: key.startsWith("pat-") ? "private_app_pat" : "unknown",
};

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { http: res.status, ok: res.ok, json };
}

const me = await call("GET", "/integrations/v1/me");
const tokenInfo = await call("POST", "/oauth/v2/private-apps/get/access-token-info", { tokenKey: key });
const v4 = await call("GET", "/automation/v4/flows?limit=100");
const v3 = await call("GET", "/automation/v3/workflows");
const account = await call("GET", "/account-info/v3/details");

const scopes = Array.isArray(tokenInfo.json?.scopes) ? tokenInfo.json.scopes.map(String).sort() : [];

console.log(
  JSON.stringify(
    {
      fingerprint,
      integrationsMe: {
        ok: me.ok,
        http: me.http,
        portalId: me.json?.portalId || me.json?.hub_id || null,
        message: me.ok ? null : me.json?.message || null,
      },
      tokenInfo: {
        endpoint: "POST /oauth/v2/private-apps/get/access-token-info",
        ok: tokenInfo.ok,
        http: tokenInfo.http,
        hubId: tokenInfo.json?.hubId || null,
        appId: tokenInfo.json?.appId || null,
        userId: tokenInfo.json?.userId || null,
        hasAutomation: scopes.includes("automation"),
        hasWorkflowsPublicApi: scopes.includes("workflows-access-public-api"),
        scopes,
        message: tokenInfo.ok ? null : tokenInfo.json?.message || null,
      },
      automationV4: {
        endpoint: "GET /automation/v4/flows?limit=100",
        ok: v4.ok,
        http: v4.http,
        hubspotBody: v4.json,
      },
      automationV3: {
        endpoint: "GET /automation/v3/workflows",
        ok: v3.ok,
        http: v3.http,
        hubspotBody: v3.json,
      },
      accountInfo: {
        ok: account.ok,
        http: account.http,
        portalId: account.json?.portalId || null,
        timeZone: account.json?.timeZone || null,
        companyCurrency: account.json?.companyCurrency || null,
        uiDomain: account.json?.uiDomain || null,
        message: account.ok ? null : account.json?.message || null,
      },
      diagnosis:
        v4.ok
          ? "automation_api_ok"
          : tokenInfo.ok && !scopes.includes("automation")
            ? "live_token_missing_automation_scope"
            : tokenInfo.ok && scopes.includes("automation")
              ? "automation_scope_present_but_api_denied_portal_entitlement_or_feature"
              : "unable_to_read_token_scopes_see_http_bodies",
    },
    null,
    2,
  ),
);

process.exit(v4.ok ? 0 : 2);
