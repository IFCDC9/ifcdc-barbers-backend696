/**
 * Phase 3A knowledge CRUD + read-only retrieval.
 * Never invents answers; escalates when missing/conflicting/unapproved.
 */
const { auraPhase3Flags } = require("./auraPhase3Flags.cjs");
const { ensureAuraKnowledgeTables } = require("./auraKnowledgeMigrations.cjs");
const { resolveLiveQuery } = require("./auraKnowledgeLiveSources.cjs");
const {
  detectPromptInjection,
  detectUnauthorizedAsk,
  sanitizeCustomerText,
} = require("./auraKnowledgeSecurity.cjs");
const { logAuraAction } = require("./auraActionLog.cjs");

const CATEGORIES = new Set([
  "services",
  "pricing",
  "duration",
  "barbers",
  "hours",
  "location",
  "policies",
  "rewards",
  "payments",
  "languages",
  "support",
  "faq",
]);

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function isEffective(row, now = new Date()) {
  if (!row) return false;
  if (row.effective_from && new Date(row.effective_from) > now) return false;
  if (row.effective_to && new Date(row.effective_to) < now) return false;
  return true;
}

async function snapshotVersion(dbQuery, article, { changedBy, changeNote } = {}) {
  await dbQuery(
    `INSERT INTO aura_knowledge_versions (
       article_id, version, title, body, status, confidence, snapshot, changed_by, change_note
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid, $9)
     ON CONFLICT (article_id, version) DO NOTHING`,
    [
      article.id,
      article.version,
      article.title,
      article.body,
      article.status,
      article.confidence,
      JSON.stringify({
        slug: article.slug,
        category: article.category,
        source_type: article.source_type,
        live_query_key: article.live_query_key,
        is_public: article.is_public,
      }),
      changedBy || null,
      changeNote || null,
    ],
  );
}

async function listArticles(dbQuery, { status = null, category = null, includePrivate = false } = {}) {
  await ensureAuraKnowledgeTables(dbQuery);
  const params = [];
  let sql = `SELECT * FROM aura_knowledge_articles WHERE 1=1`;
  if (!includePrivate) {
    sql += ` AND is_public = TRUE`;
  }
  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  if (category) {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }
  sql += ` ORDER BY updated_at DESC LIMIT 200`;
  const r = await dbQuery(sql, params);
  return r.rows || [];
}

async function getArticleById(dbQuery, id) {
  await ensureAuraKnowledgeTables(dbQuery);
  const r = await dbQuery(`SELECT * FROM aura_knowledge_articles WHERE id = $1::uuid LIMIT 1`, [id]);
  return r.rows?.[0] || null;
}

async function createArticle(dbQuery, payload, actor = {}) {
  await ensureAuraKnowledgeTables(dbQuery);
  const title = String(payload.title || "").trim();
  const body = String(payload.body || "").trim();
  const category = String(payload.category || "faq").trim().toLowerCase();
  if (!title || !body) return { ok: false, error: "title_and_body_required" };
  if (!CATEGORIES.has(category)) return { ok: false, error: "invalid_category" };

  const slug = String(payload.slug || slugify(title)).trim() || slugify(`article-${Date.now()}`);
  const sourceType = String(payload.sourceType || payload.source_type || "curated").trim();
  const liveQueryKey = payload.liveQueryKey || payload.live_query_key || null;
  const status = String(payload.status || "draft").trim();
  const confidence = String(payload.confidence || "approved").trim();
  const actorId = actor.userId || actor.id || null;

  const r = await dbQuery(
    `INSERT INTO aura_knowledge_articles (
       slug, category, title, body, source_type, live_query_key, status, confidence,
       is_public, effective_from, effective_to, created_by, updated_by, version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       COALESCE($9, TRUE), $10::timestamptz, $11::timestamptz, $12::uuid, $12::uuid, 1
     )
     RETURNING *`,
    [
      slug,
      category,
      title,
      body,
      sourceType,
      liveQueryKey,
      status,
      confidence,
      payload.isPublic !== false,
      payload.effectiveFrom || null,
      payload.effectiveTo || null,
      actorId,
    ],
  );
  const article = r.rows?.[0];
  if (article) await snapshotVersion(dbQuery, article, { changedBy: actorId, changeNote: "created" });
  return { ok: true, article };
}

async function updateArticle(dbQuery, id, payload, actor = {}) {
  await ensureAuraKnowledgeTables(dbQuery);
  const existing = await getArticleById(dbQuery, id);
  if (!existing) return { ok: false, error: "not_found" };

  const title = payload.title != null ? String(payload.title).trim() : existing.title;
  const body = payload.body != null ? String(payload.body).trim() : existing.body;
  const category =
    payload.category != null ? String(payload.category).trim().toLowerCase() : existing.category;
  if (!CATEGORIES.has(category)) return { ok: false, error: "invalid_category" };

  const status = payload.status != null ? String(payload.status).trim() : existing.status;
  const confidence =
    payload.confidence != null ? String(payload.confidence).trim() : existing.confidence;
  const sourceType =
    payload.sourceType != null || payload.source_type != null
      ? String(payload.sourceType || payload.source_type).trim()
      : existing.source_type;
  const liveQueryKey =
    payload.liveQueryKey !== undefined || payload.live_query_key !== undefined
      ? payload.liveQueryKey || payload.live_query_key || null
      : existing.live_query_key;
  const actorId = actor.userId || actor.id || null;
  const nextVersion = Number(existing.version || 1) + 1;

  let approvedBy = existing.approved_by;
  let approvedAt = existing.approved_at;
  if (status === "approved" && existing.status !== "approved") {
    approvedBy = actorId;
    approvedAt = new Date().toISOString();
  }
  if (status !== "approved") {
    approvedBy = status === "disabled" ? existing.approved_by : approvedBy;
  }

  const r = await dbQuery(
    `UPDATE aura_knowledge_articles SET
       title = $2,
       body = $3,
       category = $4,
       status = $5,
       confidence = $6,
       source_type = $7,
       live_query_key = $8,
       is_public = COALESCE($9, is_public),
       effective_from = COALESCE($10::timestamptz, effective_from),
       effective_to = COALESCE($11::timestamptz, effective_to),
       version = $12,
       updated_by = $13::uuid,
       approved_by = $14::uuid,
       approved_at = $15::timestamptz,
       updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING *`,
    [
      id,
      title,
      body,
      category,
      status,
      confidence,
      sourceType,
      liveQueryKey,
      payload.isPublic,
      payload.effectiveFrom || null,
      payload.effectiveTo || null,
      nextVersion,
      actorId,
      approvedBy || null,
      approvedAt || null,
    ],
  );
  const article = r.rows?.[0];
  if (article) {
    await snapshotVersion(dbQuery, article, {
      changedBy: actorId,
      changeNote: payload.changeNote || "updated",
    });
  }
  return { ok: true, article };
}

function scoreArticle(article, q) {
  const hay = `${article.title} ${article.body} ${article.category} ${article.slug}`.toLowerCase();
  const tokens = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score += 1;
  }
  if (article.category && q.toLowerCase().includes(article.category)) score += 2;
  return score;
}

function inferCategory(q) {
  const s = q.toLowerCase();
  if (/\b(price|cost|how much|pricing|rate)\b/.test(s)) return "pricing";
  if (/\b(duration|how long|minutes)\b/.test(s)) return "duration";
  if (/\b(hours?|open|close|closing)\b/.test(s)) return "hours";
  if (/\b(address|location|where|directions|phone|contact)\b/.test(s)) return "location";
  if (/\b(cancel|reschedul|refund|no-?show|late|lateness|policy)\b/.test(s)) return "policies";
  if (/\b(reward|loyalty|points|visits until)\b/.test(s)) return "rewards";
  if (/\b(paypal|cash|card|payment|pay)\b/.test(s)) return "payments";
  if (/\b(language|spanish|french|creole|translate)\b/.test(s)) return "languages";
  if (/\b(app|website|support|help)\b/.test(s)) return "support";
  if (/\b(barber|speciali[sz]e|fade|who)\b/.test(s)) return "barbers";
  if (/\b(service|haircut|beard|menu)\b/.test(s)) return "services";
  return "faq";
}

async function answerKnowledgeQuestion(dbQuery, rawQuestion, { actor = "aura", userId = null } = {}) {
  const flags = auraPhase3Flags();
  if (!flags.knowledge) {
    return { ok: false, error: "aura_phase3_knowledge_disabled", escalate: false };
  }

  const question = sanitizeCustomerText(rawQuestion);
  if (!question) {
    return { ok: false, error: "empty_question", escalate: true };
  }

  const injection = detectPromptInjection(question);
  if (injection.blocked) {
    await logAuraAction(dbQuery, {
      actor,
      userId,
      action: "knowledge_blocked",
      result: "blocked_injection",
      metadata: { reason: injection.reason },
    });
    return {
      ok: false,
      escalate: true,
      blocked: true,
      reason: injection.reason,
      message:
        "I can’t help with that request. For anything outside normal shop information, please contact Super Admin.",
    };
  }

  const unauthorized = detectUnauthorizedAsk(question);
  if (unauthorized.blocked) {
    await logAuraAction(dbQuery, {
      actor,
      userId,
      action: "knowledge_blocked",
      result: "blocked_unauthorized",
      metadata: { reason: unauthorized.reason },
    });
    return {
      ok: false,
      escalate: true,
      blocked: true,
      reason: unauthorized.reason,
      message:
        "That needs Super Admin review. I can’t access other customers’ data, refunds tooling, or system internals.",
    };
  }

  await ensureAuraKnowledgeTables(dbQuery);
  const category = inferCategory(question);
  const approved = await listArticles(dbQuery, { status: "approved", includePrivate: false });
  const effective = approved.filter((a) => isEffective(a));

  // Prefer category match then score. Category alone is never enough — require
  // real title/body token overlap so unrelated "policy" questions do not invent a match.
  const ranked = effective
    .map((a) => {
      const contentScore = scoreArticle(a, question);
      return {
        article: a,
        contentScore,
        score: contentScore + (a.category === category ? 2 : 0),
      };
    })
    .filter((x) => x.contentScore >= 2)
    .sort((a, b) => b.score - a.score || b.contentScore - a.contentScore);

  // Conflicting curated answers (near-tied scores) — escalate before guessing.
  if (ranked.length >= 2 && ranked[0].score === ranked[1].score && ranked[0].contentScore >= 2) {
    await logAuraAction(dbQuery, {
      actor,
      userId,
      action: "knowledge_escalate",
      result: "conflicting_knowledge",
      metadata: {
        question: question.slice(0, 200),
        candidates: ranked.slice(0, 3).map((x) => ({ id: x.article.id, score: x.score, slug: x.article.slug })),
      },
    });
    return {
      ok: false,
      escalate: true,
      reason: "conflicting_knowledge",
      message:
        "I found conflicting approved information. I’m escalating to Super Admin instead of guessing.",
    };
  }

  // Live-only path for pricing/services/hours/location/barbers when no curated hit.
  const liveKeyByCategory = {
    pricing: "services_catalog",
    services: "services_catalog",
    duration: "services_catalog",
    barbers: "barber_profiles",
    hours: "business_hours",
    location: "shop_location",
  };

  let best = ranked[0] || null;
  let live = null;
  let confidence = "escalate";
  let answer = null;
  let source = null;
  let version = null;
  let articleId = null;

  if (best && best.contentScore >= 2) {
    const a = best.article;
    articleId = a.id;
    version = a.version;
    source = {
      type: a.source_type,
      slug: a.slug,
      category: a.category,
      articleId: a.id,
      version: a.version,
      liveQueryKey: a.live_query_key || null,
    };
    if (a.source_type === "live_db" || a.source_type === "hybrid" || a.live_query_key) {
      live = await resolveLiveQuery(a.live_query_key || liveKeyByCategory[a.category], {
        dbQuery,
      });
      if (!live.ok) {
        await logAuraAction(dbQuery, {
          actor,
          userId,
          action: "knowledge_escalate",
          result: "live_data_missing",
          metadata: { question: question.slice(0, 200), source, liveReason: live.reason },
        });
        return {
          ok: false,
          escalate: true,
          reason: "live_data_missing",
          message:
            "I don’t have verified live data for that right now. I’ll escalate this to Super Admin so we don’t guess.",
          source,
        };
      }
      answer =
        a.source_type === "hybrid"
          ? `${a.body}\n\nCurrent live details: ${live.summary}`
          : `Here is the current information from our live shop records: ${live.summary}`;
      confidence = a.confidence === "escalate" ? "escalate" : "approved";
    } else {
      answer = a.body;
      confidence = a.confidence || "approved";
    }
  } else if (liveKeyByCategory[category]) {
    live = await resolveLiveQuery(liveKeyByCategory[category], { dbQuery });
    if (live.ok) {
      answer = `Here is the current information from our live shop records: ${live.summary}`;
      confidence = "approved";
      source = {
        type: "live_db",
        liveQueryKey: liveKeyByCategory[category],
        category,
        version: null,
        articleId: null,
      };
    }
  }

  if (!answer || confidence === "escalate") {
    await logAuraAction(dbQuery, {
      actor,
      userId,
      action: "knowledge_escalate",
      result: "missing_or_unapproved",
      metadata: { question: question.slice(0, 200), category, source },
    });
    return {
      ok: false,
      escalate: true,
      reason: "missing_or_unapproved",
      message:
        "I don’t have an approved answer for that yet. I’ve noted it for Super Admin so we can add verified information.",
      source,
    };
  }

  const result = {
    ok: true,
    escalate: false,
    answer,
    confidence,
    source,
    version,
    articleId,
    category,
    timestamp: new Date().toISOString(),
    liveFacts: live?.facts || null,
  };

  await logAuraAction(dbQuery, {
    actor,
    userId,
    action: "knowledge_answer",
    result: "answered",
    metadata: {
      question: question.slice(0, 200),
      category,
      confidence,
      source,
      version,
      articleId,
      timestamp: result.timestamp,
    },
  });

  return result;
}

/** Seed starter curated policy/FAQ drafts (disabled until Super Admin approves). */
async function seedStarterKnowledgeDrafts(dbQuery) {
  await ensureAuraKnowledgeTables(dbQuery);
  const starters = [
    {
      slug: "cancellation-policy",
      category: "policies",
      title: "Cancellation policy",
      body: "Please cancel or reschedule as early as possible. Same-day cancellations may be subject to shop policy. For refund questions, Super Admin must review the booking.",
      sourceType: "curated",
      status: "draft",
    },
    {
      slug: "payment-methods",
      category: "payments",
      title: "Accepted payment methods",
      body: "We accept PayPal checkout in the app/website for online bookings. In-shop payment options may also be available depending on the appointment.",
      sourceType: "curated",
      status: "draft",
    },
    {
      slug: "rewards-overview",
      category: "rewards",
      title: "Rewards program",
      body: "IFCDC Rewards tracks points from completed visits. Open Profile → Rewards in the app to see your balance and available rewards.",
      sourceType: "curated",
      status: "draft",
    },
    {
      slug: "services-live",
      category: "services",
      title: "Services and pricing (live)",
      body: "Service names, prices, and durations are loaded from the live barber services catalog.",
      sourceType: "live_db",
      liveQueryKey: "services_catalog",
      status: "draft",
    },
    {
      slug: "hours-live",
      category: "hours",
      title: "Business hours (live)",
      body: "Hours are loaded from live barber schedule settings.",
      sourceType: "live_db",
      liveQueryKey: "business_hours",
      status: "draft",
    },
    {
      slug: "location-live",
      category: "location",
      title: "Location and contact (live)",
      body: "Location and contact details are loaded from the live business profile.",
      sourceType: "live_db",
      liveQueryKey: "shop_location",
      status: "draft",
    },
  ];

  let created = 0;
  for (const s of starters) {
    const exists = await dbQuery(`SELECT id FROM aura_knowledge_articles WHERE slug = $1 LIMIT 1`, [
      s.slug,
    ]);
    if (exists.rows?.[0]) continue;
    await createArticle(dbQuery, s, { userId: null });
    created += 1;
  }
  return { ok: true, created };
}

module.exports = {
  CATEGORIES,
  listArticles,
  getArticleById,
  createArticle,
  updateArticle,
  answerKnowledgeQuestion,
  seedStarterKnowledgeDrafts,
  inferCategory,
  scoreArticle,
};
