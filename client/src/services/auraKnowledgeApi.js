import { authenticatedJson } from "../lib/appSession.js";

function authHeaders() {
  return { Accept: "application/json" };
}

export async function fetchAuraKnowledgeStatus() {
  return authenticatedJson("/api/aura/phase3/status", { headers: authHeaders() });
}

export async function fetchAuraKnowledgeArticles(params = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.category) q.set("category", params.category);
  const suffix = q.toString() ? `?${q}` : "";
  return authenticatedJson(`/api/aura/phase3/admin/knowledge${suffix}`, { headers: authHeaders() });
}

export async function createAuraKnowledgeArticle(body) {
  return authenticatedJson("/api/aura/phase3/admin/knowledge", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateAuraKnowledgeArticle(id, body) {
  return authenticatedJson(`/api/aura/phase3/admin/knowledge/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function seedAuraKnowledgeDrafts() {
  return authenticatedJson("/api/aura/phase3/admin/knowledge/seed-drafts", {
    method: "POST",
    headers: authHeaders(),
  });
}

export async function migrateAuraKnowledge() {
  return authenticatedJson("/api/aura/phase3/admin/migrate", {
    method: "POST",
    headers: authHeaders(),
  });
}

export async function askAuraKnowledge(question) {
  return authenticatedJson("/api/aura/phase3/knowledge/ask", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
}
