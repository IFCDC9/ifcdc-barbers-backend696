import express from "express";
import { buildAuraChatThread, needsAuraChatGuidance, resolveAuraChatKeywordIntent, AURA_CHAT_CONVERSATION_RULES } from "./auraChatConversation.js";
import { dbQuery } from "./db.js";
import { extractBearerToken, resolveAuthPayload } from "./authRoutes.js";
import { loadBarberSettingsRow } from "./barberScope.js";
import { barberAuraEffective } from "./subscriptionTier.js";
import {
  auraChatNavigateBook,
  auraChatNavigateStylesSuffix,
  normalizeBarberLang,
  openAiLanguageInstruction,
} from "./auraLocale.js";
import {
  auraStructuredIntentFromKeywords,
  auraKeywordFallbackReply,
  auraUnclearFallbackReply,
} from "./auraIntent.js";
import { auraFetchStyleTitles } from "./auraData.js";

const AURA_FAILSAFE_REPLY = "I'm having trouble right now, try again.";

function getAuthUserId(req) {
  const token = extractBearerToken(req.get("authorization"));
  const p = resolveAuthPayload(token);
  return p?.id ? String(p.id) : null;
}

function auraLastUserText(body) {
  const { message, messages } = body || {};
  if (Array.isArray(messages) && messages.length) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "user" && String(m.content ?? "").trim()) return String(m.content).trim();
    }
  }
  return String(message || "").trim();
}

async function loadUserContext(userId) {
  const prefs = await dbQuery(
    `SELECT notes, favorite_service, prefs FROM aura_user_preferences WHERE user_id = $1::uuid LIMIT 1`,
    [userId],
  );
  const history = await dbQuery(
    `SELECT role, content FROM aura_chat_messages WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 24`,
    [userId],
  );
  const bookings = await dbQuery(
    `SELECT service, date::text AS date, to_char(time, 'HH24:MI') AS time, booking_status, payment_status
     FROM bookings
     WHERE user_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT 8`,
    [userId],
  );
  return {
    prefs: prefs.rows?.[0] || null,
    history: (history.rows || []).reverse(),
    bookings: bookings.rows || [],
  };
}

async function openAiReply({ apiKey, model, systemPrompt, messages }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 900,
      temperature: 0.65,
    }),
  });
  const data = await r.json().catch(() => ({}));
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!r.ok || !reply) {
    const errMsg = data.error?.message || `OpenAI HTTP ${r.status}`;
    console.error("[aura-chat] OpenAI:", errMsg);
    return { ok: false, reply: AURA_FAILSAFE_REPLY };
  }
  return { ok: true, reply };
}

/**
 * @param {import("express").Application} app
 * @param {{ assistantPrompt: string }} opts
 */
export function mountAuraChatRoutes(app, opts) {
  const assistantPrompt = String(opts?.assistantPrompt || "").trim();

  async function auraChatHandler(req, res) {
    try {
      const userId = getAuthUserId(req);
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const message = String(body.message || "").trim();
      const bodyBid = Number(body.barberId ?? body.barber_id);

      const thread = buildAuraChatThread(body);

      if (!thread.length) {
        return res.status(400).json({ error: "message required", reply: AURA_FAILSAFE_REPLY, action: "NONE" });
      }

      let barberLang = "en";
      if (Number.isFinite(bodyBid) && bodyBid > 0) {
        try {
          const st = await loadBarberSettingsRow(bodyBid);
          barberLang = st?.language || "en";
          const allowFree = String(process.env.AURA_ALLOW_FREE_TIER_CHAT || "").trim() === "1";
          if (!barberAuraEffective(st) && !allowFree) {
            const L0 = normalizeBarberLang(barberLang);
            const reply =
              L0 === "es"
                ? "AURA no está disponible en el plan Free. Actualiza a Pro o Elite para activar el asistente."
                : "AURA is not available on the Free plan. Upgrade to Pro or Elite to enable the assistant.";
            return res.status(403).json({
              error: "plan_limited",
              message: reply,
              reply,
              action: "NONE",
              aura_available: false,
            });
          }
        } catch (e) {
          console.warn("[aura-chat] barber settings:", e?.message || e);
        }
      }

      const L = normalizeBarberLang(barberLang);
      const lastUser = auraLastUserText({ message, messages: thread });

      const kw = resolveAuraChatKeywordIntent(lastUser, L);
      if (kw.matched) {
        if (kw.intent === "NAVIGATE_BOOK") {
          return res.json({ reply: auraChatNavigateBook(L), action: "NAVIGATE_BOOK" });
        }
        if (kw.intent === "NAVIGATE_STYLES") {
          let extra = "";
          try {
            const titles = await auraFetchStyleTitles(30);
            if (titles.length) {
              extra =
                L === "es"
                  ? ` Estilos que ofrecemos: ${titles.join(", ")}.`
                  : ` Styles we offer include: ${titles.join(", ")}.`;
            }
          } catch (e) {
            console.warn("[aura-chat] style list:", e?.message || e);
          }
          const opener = L === "es" ? "Listo — abriendo estilos ahora." : "I got you — opening styles now.";
          return res.json({
            reply: `${opener}${extra}${auraChatNavigateStylesSuffix(L)}`,
            action: "NAVIGATE_STYLES",
          });
        }
        if (kw.intent === "PRICING") {
          return res.json({ reply: kw.reply, action: "NAVIGATE_STYLES" });
        }
      }

      let memoryBlock = "";
      if (userId) {
        const ctx = await loadUserContext(userId);
        if (ctx.bookings?.length) {
          memoryBlock += `\nPast bookings (most recent first): ${ctx.bookings
            .map((b) => `${b.date} ${b.time} — ${b.service} (${b.booking_status})`)
            .join("; ")}.`;
        }
        if (ctx.prefs?.favorite_service) {
          memoryBlock += `\nCustomer noted favorite service: ${ctx.prefs.favorite_service}.`;
        }
        if (ctx.prefs?.notes) {
          memoryBlock += `\nCustomer notes: ${ctx.prefs.notes}.`;
        }
      }

      const cleaned = String(lastUser || "").trim();
      if (needsAuraChatGuidance(cleaned, thread)) {
        return res.json({ reply: auraUnclearFallbackReply(L), action: "NONE" });
      }

      const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
      if (!apiKey) {
        return res.status(200).json({ reply: auraKeywordFallbackReply(L), action: "NONE" });
      }

      const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
      let system =
        assistantPrompt +
        AURA_CHAT_CONVERSATION_RULES +
        openAiLanguageInstruction(L) +
        memoryBlock +
        "\nUse the customer's history when relevant. Suggest booking steps on /booking. Never invent paid amounts.";
      if (/\b(price|cost|pricing|how\s+much)\b/i.test(cleaned)) {
        system +=
          L === "es"
            ? " El usuario puede preguntar por precio. Explique que cada estilo tiene su precio en la página Estilos y que abra Estilos para comparar. No invente montos en dólares."
            : " The user may be asking about price or cost. Explain that each style has its own price on the Styles page, and they should open Styles to compare. Do not invent dollar amounts.";
      }

      const out = await openAiReply({
        apiKey,
        model,
        systemPrompt: system,
        messages: thread,
      });
      const base = String(out.reply || "").trim() || auraUnclearFallbackReply(L);
      const reply = base;

      if (userId && out.ok && reply) {
        try {
          await dbQuery(`INSERT INTO aura_chat_messages (user_id, role, content) VALUES ($1::uuid, 'user', $2)`, [
            userId,
            lastUser.slice(0, 8000),
          ]);
          await dbQuery(`INSERT INTO aura_chat_messages (user_id, role, content) VALUES ($1::uuid, 'assistant', $2)`, [
            userId,
            reply.slice(0, 8000),
          ]);
        } catch (e) {
          console.warn("[aura-chat] persist messages:", e?.message || e);
        }
      }

      return res.json({ reply, action: "NONE" });
    } catch (e) {
      console.error("[aura-chat]", e?.stack || e);
      return res.status(200).json({ reply: AURA_FAILSAFE_REPLY, action: "NONE" });
    }
  }

  app.post("/api/aura", auraChatHandler);
  app.post("/api/aura-chat", auraChatHandler);
  app.post("/aura-chat", auraChatHandler);
}
