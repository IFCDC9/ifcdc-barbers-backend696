import crypto from "node:crypto"
import express from "express"
import pool from "../db/db.js"
import supabaseService from "../db/supabaseServiceClient.js"
import { requireAuth } from "../middleware/requireAuth.js"

const router = express.Router()

function bridgeEmail(sub) {
  const safe = String(sub || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120) || "user"
  return `app-${safe}@ifcdc-bridge.app`
}

async function findAuthUserIdByEmail(email) {
  if (!supabaseService) return null
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await supabaseService.auth.admin.listUsers({ page, perPage: 200 })
    if (error) break
    const users = data?.users || []
    if (!users.length) break
    const hit = users.find((u) => u.email === email)
    if (hit?.id) return hit.id
    if (!data.nextPage) break
  }
  return null
}

/**
 * POST /api/auth/supabase-bridge
 * Requires app JWT. Returns one-time Supabase credentials for signInWithPassword (authenticated role + RLS).
 */
router.post("/supabase-bridge", requireAuth, async (req, res) => {
  // IFCDC login is custom JWT + app_users. auth_bridge is not on production and
  // must not be created implicitly. Opt-in only for local Realtime experiments.
  const enabled = String(process.env.ENABLE_SUPABASE_AUTH_BRIDGE || "").trim() === "1"
  if (!enabled) {
    res.status(410).json({
      ok: false,
      error: "supabase_auth_bridge_disabled",
      message: "App authentication uses custom JWT + app_users, not Supabase Auth.",
    })
    return
  }
  if (!supabaseService) {
    res.status(503).json({ ok: false, error: "supabase_service_not_configured" })
    return
  }

  const sub = String(req.user?.sub || "").trim()
  if (!sub) {
    res.status(400).json({ ok: false, error: "invalid_token" })
    return
  }

  const email = bridgeEmail(sub)
  const password = crypto.randomBytes(28).toString("base64url")
  const meta = {
    backend_sub: sub,
    backend_email: req.user?.email ? String(req.user.email) : null,
  }

  try {
    const mapped = await pool.query(
      "SELECT supabase_user_id::text AS id FROM auth_bridge WHERE backend_sub = $1 LIMIT 1",
      [sub]
    )
    let userId = mapped.rows[0]?.id || null

    if (userId) {
      const { error } = await supabaseService.auth.admin.updateUserById(userId, {
        email,
        password,
        user_metadata: meta,
      })
      if (error) {
        console.error("[supabase-bridge] updateUserById:", error.message)
        res.status(500).json({ ok: false, error: "supabase_update_failed", detail: error.message })
        return
      }
    } else {
      const { data, error } = await supabaseService.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: meta,
      })

      if (!error && data?.user?.id) {
        userId = data.user.id
      } else if (error) {
        const msg = String(error.message || "").toLowerCase()
        const exists = msg.includes("already") || msg.includes("registered") || msg.includes("exists")
        if (!exists) {
          res.status(500).json({ ok: false, error: "supabase_create_failed", detail: error.message })
          return
        }
        userId = await findAuthUserIdByEmail(email)
        if (!userId) {
          res.status(500).json({ ok: false, error: "supabase_user_exists_unmapped", detail: error.message })
          return
        }
        const { error: upErr } = await supabaseService.auth.admin.updateUserById(userId, {
          password,
          user_metadata: meta,
        })
        if (upErr) {
          res.status(500).json({ ok: false, error: "supabase_update_failed", detail: upErr.message })
          return
        }
      }

      if (!userId) {
        res.status(500).json({ ok: false, error: "supabase_no_user_id" })
        return
      }

      await pool.query(
        `INSERT INTO auth_bridge (backend_sub, supabase_user_id)
         VALUES ($1, $2::uuid)
         ON CONFLICT (backend_sub) DO UPDATE SET supabase_user_id = EXCLUDED.supabase_user_id, updated_at = NOW()`,
        [sub, userId]
      )
    }

    res.json({
      ok: true,
      supabase: {
        email,
        password,
        note: "Use once with signInWithPassword; session tokens are persisted by the Supabase client only.",
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[supabase-bridge] failed:", msg)
    res.status(500).json({ ok: false, error: "supabase_bridge_failed", detail: msg })
  }
})

export default router
