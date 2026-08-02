/**
 * AURA Phase 3A knowledge routes — 404 unless AURA_PHASE3_ENABLED.
 * Admin CRUD requires platform admin/super. Public ask is read-only.
 */
const express = require("express");
const { isAuraPhase3Enabled, auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { ensureAuraKnowledgeTables } = require("./auraKnowledgeMigrations.cjs");
const {
  listArticles,
  getArticleById,
  createArticle,
  updateArticle,
  answerKnowledgeQuestion,
  seedStarterKnowledgeDrafts,
  CATEGORIES,
} = require("./auraKnowledgeService.cjs");

function createAuraPhase3Router({ dbQuery, requireAdmin, requireAuth } = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!isAuraPhase3Enabled()) {
      return res.status(404).json({ ok: false, error: "aura_phase3_disabled" });
    }
    return next();
  });

  router.get("/status", (_req, res) => {
    return res.json({
      ok: true,
      phase: 3,
      flags: auraPhase3Flags(),
      note:
        "Phase 3 defaults OFF. Knowledge is read-only until Super Admin approves articles. Preferences (3B1) require separate flags and consent.",
    });
  });

  try {
    const { attachAuraPreferenceRoutes } = require("./auraPreferenceRoutes.cjs");
    attachAuraPreferenceRoutes(router, { dbQuery, requireAdmin, requireAuth });
  } catch (e) {
    console.warn("[aura-phase3] preference routes skipped:", e?.message || e);
  }

  router.post("/knowledge/ask", async (req, res) => {
    try {
      const flags = auraPhase3Flags();
      if (!flags.knowledge) {
        return res.status(404).json({ ok: false, error: "aura_phase3_knowledge_disabled" });
      }
      const question = req.body?.question || req.body?.message || req.query.q;
      const out = await answerKnowledgeQuestion(dbQuery, question, {
        userId: req.user?.id || null,
      });
      return res.status(out.ok ? 200 : out.blocked ? 403 : 200).json(out);
    } catch (e) {
      console.error("[aura-phase3] knowledge ask:", e?.message || e);
      return res.status(500).json({ ok: false, error: "knowledge_ask_failed" });
    }
  });

  async function guardAdmin(req, res) {
    if (typeof requireAdmin !== "function") return true;
    await new Promise((resolve, reject) => {
      requireAdmin(req, res, (err) => (err ? reject(err) : resolve()));
    });
    return !res.headersSent;
  }

  router.get("/admin/knowledge", async (req, res) => {
    try {
      if (!(await guardAdmin(req, res))) return;
      const flags = auraPhase3Flags();
      if (!flags.knowledge) {
        return res.status(404).json({ ok: false, error: "aura_phase3_knowledge_disabled" });
      }
      const rows = await listArticles(dbQuery, {
        status: req.query.status || null,
        category: req.query.category || null,
        includePrivate: true,
      });
      return res.json({ ok: true, categories: [...CATEGORIES], articles: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "list_failed" });
    }
  });

  router.get("/admin/knowledge/:id", async (req, res) => {
    try {
      if (!(await guardAdmin(req, res))) return;
      const row = await getArticleById(dbQuery, req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, article: row });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "get_failed" });
    }
  });

  router.post("/admin/knowledge", async (req, res) => {
    try {
      if (!(await guardAdmin(req, res))) return;
      const flags = auraPhase3Flags();
      if (!flags.knowledge) {
        return res.status(404).json({ ok: false, error: "aura_phase3_knowledge_disabled" });
      }
      const out = await createArticle(dbQuery, req.body || {}, {
        userId: req.user?.id || null,
      });
      return res.status(out.ok ? 201 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "create_failed" });
    }
  });

  router.patch("/admin/knowledge/:id", async (req, res) => {
    try {
      if (!(await guardAdmin(req, res))) return;
      const out = await updateArticle(dbQuery, req.params.id, req.body || {}, {
        userId: req.user?.id || null,
      });
      return res.status(out.ok ? 200 : out.error === "not_found" ? 404 : 400).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "update_failed" });
    }
  });

  router.post("/admin/knowledge/seed-drafts", async (req, res) => {
    try {
      if (!(await guardAdmin(req, res))) return;
      const out = await seedStarterKnowledgeDrafts(dbQuery);
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "seed_failed" });
    }
  });

  router.post("/admin/migrate", async (req, res) => {
    try {
      if (!(await guardAdmin(req, res))) return;
      await ensureAuraKnowledgeTables(dbQuery);
      return res.json({ ok: true, migrated: ["aura_knowledge_articles", "aura_knowledge_versions"] });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || "migrate_failed" });
    }
  });

  return router;
}

module.exports = { createAuraPhase3Router };
