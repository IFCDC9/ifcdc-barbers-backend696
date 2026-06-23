import express from "express";
import { dbQuery } from "./db.js";
import { comparePassword, hashPassword, validatePasswordStrength } from "./authPasswordPolicy.js";
import { normalizeEmail } from "./authStore.js";
import { isSuperAdminEmail } from "./rolePolicy.js";
import { roundMoney2 } from "./styleBookingPricing.js";
import { issueAppUserJwt } from "./authRoutes.js";
import { notifySuperAdminsNewBarber } from "./adminBarberService.js";
import { notifySuperAdminsNewShop } from "./adminShopsService.js";

/**
 * POST /api/onboarding/business — one-shot shop signup (user + business + barber + service).
 * Body: { name, email, password, businessName, businessPhone?, barberName?, serviceName?, servicePrice? }
 * Existing email: verifies password, continues shop setup; returns { existing: true }.
 */
export function mountOnboardingBusinessRoutes(app) {
  app.post("/api/onboarding/business", async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const businessName = String(req.body?.businessName || req.body?.business_name || "").trim();
      const businessPhone = String(req.body?.businessPhone || req.body?.business_phone || "").trim() || null;
      const barberName = String(req.body?.barberName || req.body?.barber_name || name || "Owner").trim();
      const serviceName = String(req.body?.serviceName || req.body?.service_name || "General cut").trim();
      const servicePrice = roundMoney2(Number(req.body?.servicePrice ?? req.body?.service_price ?? 25));

      if (!name) return res.status(400).json({ ok: false, error: "name_required" });
      if (!email) return res.status(400).json({ ok: false, error: "email_required" });
      if (!businessName) return res.status(400).json({ ok: false, error: "business_name_required" });
      const pw = validatePasswordStrength(password);
      if (!pw.valid) return res.status(400).json({ ok: false, error: "weak_password", message: pw.message });

      await dbQuery(`ALTER TABLE barber_services ADD COLUMN IF NOT EXISTS business_id BIGINT;`);

      const biz = await dbQuery(
        `INSERT INTO businesses (
           name, phone, plan, subscription_status, account_status, approval_status, access_plan,
           free_access_enabled, paid_subscription_required, bookings_enabled, payment_processing_enabled
         )
         VALUES ($1, $2, 'free', 'inactive', 'pending', 'pending', 'pending', false, true, false, false)
         RETURNING id`,
        [businessName, businessPhone],
      );
      const businessId = biz.rows?.[0]?.id;
      if (!businessId) throw new Error("business_insert_failed");

      const found = await dbQuery(
        `SELECT id, name, email, password_hash, role, barber_id, business_id
         FROM app_users WHERE lower(trim(email)) = lower(trim($1)) LIMIT 1`,
        [email],
      );
      const existingRow = found.rows?.[0];
      let existingAccount = false;
      let user;

      if (existingRow?.id) {
        const pwdOk = await comparePassword(password, existingRow.password_hash);
        if (!pwdOk) {
          await dbQuery(`DELETE FROM businesses WHERE id = $1`, [businessId]);
          return res.status(401).json({
            ok: false,
            error: "invalid_credentials",
            loginRequired: true,
            message:
              "This email is already registered. Sign in with the correct password, or use Forgot password on the login page.",
          });
        }
        existingAccount = true;
        const displayName = name || String(existingRow.name || "").trim() || "Owner";
        const role = String(existingRow.role || "").toLowerCase();
        const promoteBarber =
          role !== "barber" && role !== "admin" && role !== "super_admin" && role !== "shop_owner";
        await dbQuery(
          `UPDATE app_users SET name = $1::text, role = CASE WHEN $3::boolean THEN 'barber' ELSE role END
           WHERE id = $2::uuid`,
          [displayName, existingRow.id, promoteBarber],
        );
        const refreshed = await dbQuery(
          `SELECT id, name, email, role, barber_id, business_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
          [existingRow.id],
        );
        user = refreshed.rows?.[0];
        if (!user?.id) throw new Error("user_reload_failed");
      } else {
        const passwordHash = await hashPassword(password);
        const userIns = await dbQuery(
          `INSERT INTO app_users (name, email, password_hash, role, business_id)
           VALUES ($1, $2, $3, 'barber', $4)
           RETURNING id, name, email, role, business_id`,
          [name, email, passwordHash, businessId],
        );
        user = userIns.rows?.[0];
        if (!user?.id) throw new Error("user_insert_failed");
      }

      let barberId = user.barber_id != null ? Number(user.barber_id) : null;

      if (!Number.isFinite(barberId)) {
        const barberIns = await dbQuery(
          `INSERT INTO barbers (name, business_id, user_id, phone)
           VALUES ($1, $2, $3::uuid, $4)
           RETURNING id`,
          [barberName, businessId, user.id, businessPhone],
        );
        barberId = barberIns.rows?.[0]?.id;
        if (barberId == null) throw new Error("barber_insert_failed");
        await dbQuery(`UPDATE app_users SET barber_id = $1, business_id = $2 WHERE id = $3::uuid`, [
          barberId,
          businessId,
          user.id,
        ]);
      } else {
        const upd = await dbQuery(
          `UPDATE barbers SET business_id = $1, name = $2, phone = COALESCE($3, phone)
           WHERE id = $4 AND user_id = $5::uuid
           RETURNING id`,
          [businessId, barberName, businessPhone, barberId, user.id],
        );
        if (!upd.rows?.length) {
          const barberIns = await dbQuery(
            `INSERT INTO barbers (name, business_id, user_id, phone)
             VALUES ($1, $2, $3::uuid, $4)
             RETURNING id`,
            [barberName, businessId, user.id, businessPhone],
          );
          barberId = barberIns.rows?.[0]?.id;
          if (barberId == null) throw new Error("barber_insert_failed");
        }
        await dbQuery(`UPDATE app_users SET business_id = $1, barber_id = $2 WHERE id = $3::uuid`, [
          businessId,
          barberId,
          user.id,
        ]);
      }

      await dbQuery(
        `INSERT INTO barber_services (barber_id, business_id, name, price, duration_minutes, is_active)
         VALUES ($1, $2, $3, $4, 30, true)`,
        [barberId, businessId, serviceName, servicePrice],
      );

      await dbQuery(
        `INSERT INTO barber_settings (barber_id, subscription_tier, aura_enabled)
         VALUES ($1, 'pro', true)
         ON CONFLICT (barber_id) DO NOTHING`,
        [barberId],
      );

      if (isSuperAdminEmail(email)) {
        await dbQuery(`UPDATE app_users SET role = 'super_admin' WHERE id = $1::uuid`, [user.id]);
      } else {
        void notifySuperAdminsNewBarber({
          barberId,
          fullName: barberName || name,
          shopName: businessName,
          city: null,
          state: null,
          email,
        });
        void notifySuperAdminsNewShop({
          businessId,
          shopName: businessName,
          ownerName: barberName || name,
          city: null,
          state: null,
          email,
        });
      }

      const uFinal = await dbQuery(
        `SELECT id, name, email, role, barber_id, business_id FROM app_users WHERE id = $1::uuid LIMIT 1`,
        [user.id],
      );
      const u = uFinal.rows?.[0] || user;

      const token = issueAppUserJwt(u);
      const status = existingAccount ? 200 : 201;
      return res.status(status).json({
        ok: true,
        success: true,
        existing: existingAccount,
        token,
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          business_id: businessId,
          barber_id: barberId,
        },
        business: { id: businessId, name: businessName },
        barber: { id: barberId, name: barberName },
        service: { name: serviceName, price: servicePrice },
      });
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("duplicate") || e?.code === "23505") {
        return res.status(409).json({ ok: false, error: "email_exists", message: "Email already registered." });
      }
      console.error("[onboarding/business]", e?.stack || e);
      return res.status(500).json({ ok: false, error: "onboarding_failed", message: e?.message || String(e) });
    }
  });
}
