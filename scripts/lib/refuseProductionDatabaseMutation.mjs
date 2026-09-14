/**
 * Refuse live writes when DATABASE_URL points at production emerald-kite.
 * Isolation tests must use mocks or a dedicated local/test database.
 */
export function isProductionDatabaseUrl(url = process.env.DATABASE_URL) {
  const u = String(url || "");
  if (!u.trim()) return false;
  if (/localhost|127\.0\.0\.1/i.test(u)) return false;
  return /vtkxuagevtiwtoheomjt/i.test(u);
}

export function refuseProductionDatabaseMutation(scriptName = "script") {
  if (!isProductionDatabaseUrl()) return false;
  console.error(
    JSON.stringify({
      ok: false,
      skipped: true,
      reason: "refusing_production_database_mutation",
      script: scriptName,
      hint: "Use mocks, an isolated test DB, or DATABASE_URL that is not production.",
    }),
  );
  return true;
}
