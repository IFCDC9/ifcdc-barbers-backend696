/**
 * Phase 3A knowledge tables — additive, safe when DB unavailable.
 */
async function ensureAuraKnowledgeTables(dbQuery) {
  if (typeof dbQuery !== "function") return;

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_knowledge_articles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'curated',
      live_query_key TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      confidence TEXT NOT NULL DEFAULT 'approved',
      is_public BOOLEAN NOT NULL DEFAULT TRUE,
      effective_from TIMESTAMPTZ,
      effective_to TIMESTAMPTZ,
      created_by UUID,
      updated_by UUID,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT aura_knowledge_status_chk
        CHECK (status IN ('draft', 'approved', 'disabled')),
      CONSTRAINT aura_knowledge_source_chk
        CHECK (source_type IN ('curated', 'live_db', 'hybrid')),
      CONSTRAINT aura_knowledge_confidence_chk
        CHECK (confidence IN ('approved', 'provisional', 'escalate'))
    )
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aura_knowledge_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      article_id UUID NOT NULL REFERENCES aura_knowledge_articles(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence TEXT NOT NULL,
      snapshot JSONB,
      changed_by UUID,
      change_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (article_id, version)
    )
  `);

  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_knowledge_articles_status_idx
     ON aura_knowledge_articles (status, category)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_knowledge_articles_public_idx
     ON aura_knowledge_articles (is_public, status)
     WHERE is_public = TRUE`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS aura_knowledge_versions_article_idx
     ON aura_knowledge_versions (article_id, version DESC)`,
  );
}

module.exports = { ensureAuraKnowledgeTables };
