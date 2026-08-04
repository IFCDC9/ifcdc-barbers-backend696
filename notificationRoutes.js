import express from "express";
import { dbQuery } from "./db.js";
import { requireAuth } from "./authRoutes.js";
import {
  ensurePushTokensTable,
  ensureNotificationPreferencesTable,
} from "./pushNotificationsMigrations.js";

/**
 * Factory so server.js can inject the push dispatcher (loaded as CJS).
 *
 * @param {{ sendPushToUsers?: Function, isExpoPushToken?: Function }} deps
 */
export function createNotificationRouter(deps = {}) {
  const router = express.Router();
  const sendPushToUsers = deps.sendPushToUsers;
  const isExpoPushToken =
    deps.isExpoPushToken ||
    ((t) =>
      typeof t === "string" &&
      (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken[")));

  function clean(v) {
    return typeof v === "string" ? v.trim().slice(0, 240) : null;
  }

  function actorFromReq(req) {
    return {
      userId: req.user?.id ? String(req.user.id) : null,
      role: req.user?.role ? String(req.user.role).toLowerCase() : "user",
      email: req.user?.email ? String(req.user.email) : null,
      businessId:
        req.user?.businessId != null && req.user?.businessId !== ""
          ? Number(req.user.businessId) || null
          : null,
    };
  }

  /**
   * POST /api/notifications/register-token
   * Body: { token, platform?, deviceName?, appVersion?, barberId? }
   * Idempotent — re-registering an existing (user_id, expo_token) pair updates
   * the metadata + last_seen_at and re-activates the row.
   */
  router.post("/register-token", requireAuth, async (req, res) => {
    try {
      await ensurePushTokensTable();
      const actor = actorFromReq(req);
      if (!actor.userId) {
        return res.status(401).json({ ok: false, message: "unauthorized" });
      }

      const token = clean(req.body?.token);
      const platform = clean(req.body?.platform);
      const deviceName = clean(req.body?.deviceName);
      const appVersion = clean(req.body?.appVersion);
      const barberIdRaw =
        req.body?.barberId != null && req.body?.barberId !== ""
          ? String(req.body.barberId).slice(0, 64)
          : null;

      if (!token || !isExpoPushToken(token)) {
        return res.status(400).json({
          ok: false,
          message: "A valid Expo push token is required.",
        });
      }

      await dbQuery(
        `INSERT INTO push_tokens
           (user_id, expo_token, platform, device_name, app_version, role, business_id, barber_id, is_active, created_at, updated_at, last_seen_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW(), NOW())
         ON CONFLICT (user_id, expo_token) DO UPDATE SET
           platform = EXCLUDED.platform,
           device_name = EXCLUDED.device_name,
           app_version = EXCLUDED.app_version,
           role = EXCLUDED.role,
           business_id = EXCLUDED.business_id,
           barber_id = EXCLUDED.barber_id,
           is_active = true,
           updated_at = NOW(),
           last_seen_at = NOW()`,
        [
          actor.userId,
          token,
          platform,
          deviceName,
          appVersion,
          actor.role,
          actor.businessId,
          barberIdRaw,
        ],
      );

      console.log(
        `[push] register-token user=${actor.userId.slice(0, 8)} role=${actor.role} platform=${platform || "—"}`,
      );
      return res.json({ ok: true, message: "Push token saved." });
    } catch (e) {
      console.warn("[push] register-token failed:", e?.message || e);
      return res
        .status(500)
        .json({ ok: false, message: "Could not save push token right now." });
    }
  });

  /**
   * DELETE /api/notifications/register-token
   * Body: { token }
   * Marks the device's token inactive so it stops receiving pushes (e.g. on
   * sign out from this device).
   */
  router.delete("/register-token", requireAuth, async (req, res) => {
    try {
      await ensurePushTokensTable();
      const actor = actorFromReq(req);
      if (!actor.userId) return res.status(401).json({ ok: false });
      const token = clean(req.body?.token);
      if (!token) {
        return res.status(400).json({ ok: false, message: "token is required." });
      }
      await dbQuery(
        `UPDATE push_tokens SET is_active = false, updated_at = NOW()
         WHERE user_id = $1::uuid AND expo_token = $2`,
        [actor.userId, token],
      );
      return res.json({ ok: true });
    } catch (e) {
      console.warn("[push] unregister-token failed:", e?.message || e);
      return res.status(500).json({ ok: false, message: "Could not remove push token." });
    }
  });

  /**
   * GET /api/notifications/preferences
   * Returns the caller's preferences, creating defaults on first access.
   */
  router.get("/preferences", requireAuth, async (req, res) => {
    try {
      await ensureNotificationPreferencesTable();
      const actor = actorFromReq(req);
      if (!actor.userId) return res.status(401).json({ ok: false });

      const r = await dbQuery(
        `SELECT user_id, push_enabled, booking_confirmations, reminders, cancellations,
                reschedules, status_updates, admin_alerts, marketing,
                email_booking_confirmations, email_reminders,
                sms_opt_in, sms_booking_confirmations, sms_reminders, sms_cancellations,
                sms_payment_updates, updated_at
         FROM notification_preferences
         WHERE user_id = $1::uuid
         LIMIT 1`,
        [actor.userId],
      );
      let prefs = r.rows?.[0];
      if (!prefs) {
        const ins = await dbQuery(
          `INSERT INTO notification_preferences (user_id) VALUES ($1::uuid)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING user_id, push_enabled, booking_confirmations, reminders, cancellations,
                     reschedules, status_updates, admin_alerts, marketing,
                     email_booking_confirmations, email_reminders,
                     sms_opt_in, sms_booking_confirmations, sms_reminders, sms_cancellations,
                     sms_payment_updates, updated_at`,
          [actor.userId],
        );
        prefs = ins.rows?.[0] || {
          user_id: actor.userId,
          push_enabled: true,
          booking_confirmations: true,
          reminders: true,
          cancellations: true,
          reschedules: true,
          status_updates: true,
          admin_alerts: true,
          marketing: false,
          email_booking_confirmations: true,
          email_reminders: true,
          sms_opt_in: true,
          sms_booking_confirmations: true,
          sms_reminders: true,
          sms_cancellations: true,
          sms_payment_updates: true,
        };
      }
      return res.json({ ok: true, preferences: prefs });
    } catch (e) {
      console.warn("[push] get preferences failed:", e?.message || e);
      return res
        .status(500)
        .json({ ok: false, message: "Preferences could not be loaded right now." });
    }
  });

  const PREF_KEYS = [
    "push_enabled",
    "booking_confirmations",
    "reminders",
    "cancellations",
    "reschedules",
    "status_updates",
    "admin_alerts",
    "marketing",
    "email_booking_confirmations",
    "email_reminders",
    "sms_opt_in",
    "sms_booking_confirmations",
    "sms_reminders",
    "sms_cancellations",
    "sms_payment_updates",
  ];

  /**
   * PUT /api/notifications/preferences
   * Body: any subset of the boolean fields. Marketing remains the only OFF-by-default
   * preference; everything else must be explicitly opted out by the user.
   */
  router.put("/preferences", requireAuth, async (req, res) => {
    try {
      await ensureNotificationPreferencesTable();
      const actor = actorFromReq(req);
      if (!actor.userId) return res.status(401).json({ ok: false });

      const updates = {};
      for (const key of PREF_KEYS) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
          updates[key] = !!req.body[key];
        }
      }

      const insertCols = ["user_id", ...PREF_KEYS];
      const insertVals = [
        actor.userId,
        ...PREF_KEYS.map((k) => {
          if (Object.prototype.hasOwnProperty.call(updates, k)) return updates[k];
          // Defaults: marketing OFF, everything else ON.
          if (k === "marketing") return false;
          return true;
        }),
      ];
      const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(", ");
      const setLines = PREF_KEYS.filter((k) =>
        Object.prototype.hasOwnProperty.call(updates, k),
      ).map((k) => `${k} = EXCLUDED.${k}`);
      const setSql = setLines.length
        ? `${setLines.join(", ")}, updated_at = NOW()`
        : `updated_at = NOW()`;

      const sql = `INSERT INTO notification_preferences (${insertCols.join(", ")})
                   VALUES (${placeholders})
                   ON CONFLICT (user_id) DO UPDATE SET ${setSql}
                   RETURNING user_id, ${PREF_KEYS.join(", ")}, updated_at`;

      const r = await dbQuery(sql, insertVals);
      return res.json({ ok: true, preferences: r.rows?.[0] || null });
    } catch (e) {
      console.warn("[push] put preferences failed:", e?.message || e);
      return res
        .status(500)
        .json({ ok: false, message: "Preferences could not be saved right now." });
    }
  });

  /**
   * POST /api/notifications/test
   * Sends a real push to *this user's* registered devices via Expo, in addition
   * to the local notification fired from the mobile client. Useful for
   * verifying token registration end-to-end.
   */
  router.post("/test", requireAuth, async (req, res) => {
    try {
      await ensurePushTokensTable();
      await ensureNotificationPreferencesTable();
      const actor = actorFromReq(req);
      if (!actor.userId) return res.status(401).json({ ok: false });

      if (typeof sendPushToUsers !== "function") {
        return res.json({ ok: true, sent: 0, message: "Test queued (dispatcher unavailable)." });
      }

      const result = await sendPushToUsers({
        dbQuery,
        userIds: [actor.userId],
        kind: "test",
        title: "IFCDC Test Notification",
        body: "If you can read this, push notifications are working.",
        data: { kind: "test" },
      });

      return res.json({
        ok: true,
        sent: result.sent || 0,
        eligible: result.eligible || 0,
        message:
          result.sent > 0
            ? "Test notification sent to your registered devices."
            : "No active devices yet — open the app on your phone to register one.",
      });
    } catch (e) {
      console.warn("[push] test send failed:", e?.message || e);
      return res
        .status(500)
        .json({ ok: false, message: "Test notification could not be sent right now." });
    }
  });

  return router;
}

export default createNotificationRouter;
