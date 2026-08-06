/**
 * Founder operational notifications.
 * Channel order: in-app → push → email → SMS (only when A2P transactional SMS is enabled).
 * Never blocks DB logging when SMS is disabled. Never sends customer SMS from founder handset.
 */
const { sendEmail } = require("./emailResend.cjs");
const pushNotifier = require("./pushNotifier.cjs");
const { isSmsNotificationsEnabled } = require("./smsFlags.cjs");
const { sendTransactionalSms } = require("./smsDeliveryService.cjs");
const { getOfficialAuraBusinessE164 } = require("./auraVoiceIntelligenceFlags.cjs");
const {
  founderPhoneE164,
  founderEmail,
  maskPhonePartial,
  FOUNDER_IDENTITY,
} = require("./auraFounderIdentity.cjs");
const { ensureAuraFounderSchema } = require("./auraFounderMigrations.cjs");
const { recordFounderActivity, sanitizeFounderEventPayload } = require("./auraFounderAudit.cjs");

async function resolveFounderUserIds(dbQuery) {
  const ids = new Set();
  try {
    const r = await dbQuery(
      `SELECT id FROM app_users
       WHERE role IN ('super_admin','admin')
          OR lower(email) = lower($1)
       LIMIT 20`,
      [founderEmail()],
    );
    for (const row of r.rows || []) {
      if (row.id) ids.add(String(row.id));
    }
  } catch {
    /* ignore */
  }
  return Array.from(ids);
}

async function logNotification(dbQuery, row) {
  try {
    await ensureAuraFounderSchema(dbQuery);
    await dbQuery(
      `INSERT INTO aura_founder_notification_log
         (event_id, channel, target, ok, skipped, reason, detail)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        row.eventId || null,
        row.channel,
        row.target || null,
        row.ok == null ? null : Boolean(row.ok),
        Boolean(row.skipped),
        row.reason || null,
        row.detail ? JSON.stringify(row.detail) : null,
      ],
    );
  } catch (e) {
    console.warn("[aura-founder] notify_log:", e?.message || e);
  }
}

function buildNotifyCopy(event) {
  const type = String(event.event_type || event.eventType || "ops_update");
  const customer = event.customer_name || event.customerName || "Customer";
  const service = event.service_name || event.serviceName || "service";
  const barber = event.barber_name || event.barberName || "barber";
  const title = `AURA: ${type.replace(/_/g, " ")}`;
  const body = `${customer} — ${service} with ${barber}. Booking ${String(event.booking_id || event.bookingId || "n/a").slice(0, 8)}.`;
  return { title, body };
}

/**
 * Persist founder event + fan out notifications. Never throws to callers.
 */
async function emitFounderEvent(dbQuery, eventInput = {}) {
  const q = dbQuery;
  if (typeof q !== "function") return { ok: false, reason: "no_db" };

  try {
    await ensureAuraFounderSchema(q);
    const payload = sanitizeFounderEventPayload(eventInput.payload || eventInput);
    const eventType = String(eventInput.eventType || eventInput.event_type || "ops_update").slice(0, 80);
    const customerPhone = eventInput.customerPhone || eventInput.customer_phone || null;
    const masked = eventInput.customerPhoneMasked || maskPhonePartial(customerPhone);

    const ins = await q(
      `INSERT INTO aura_founder_events
         (event_type, booking_id, customer_name, customer_phone_masked, barber_name, service_name,
          original_date, original_time, new_date, new_time, cancellation_reason,
          payment_status, booking_status, action_required, source, payload)
       VALUES ($1,$2::uuid,$3,$4,$5,$6,$7::date,$8,$9::date,$10,$11,$12,$13,$14,$15,$16::jsonb)
       RETURNING *`,
      [
        eventType,
        eventInput.bookingId || eventInput.booking_id || null,
        eventInput.customerName || eventInput.customer_name || null,
        masked || null,
        eventInput.barberName || eventInput.barber_name || null,
        eventInput.serviceName || eventInput.service_name || null,
        eventInput.originalDate || eventInput.original_date || null,
        eventInput.originalTime || eventInput.original_time || null,
        eventInput.newDate || eventInput.new_date || null,
        eventInput.newTime || eventInput.new_time || null,
        eventInput.cancellationReason || eventInput.cancellation_reason || null,
        eventInput.paymentStatus || eventInput.payment_status || null,
        eventInput.bookingStatus || eventInput.booking_status || null,
        Boolean(eventInput.actionRequired ?? eventInput.action_required),
        eventInput.source || "system",
        JSON.stringify(payload),
      ],
    );
    const event = ins.rows?.[0];
    if (!event) return { ok: false, reason: "insert_failed" };

    await recordFounderActivity(q, {
      eventKind: "founder_event_recorded",
      ok: true,
      detail: { eventType, eventId: event.id, bookingId: event.booking_id },
    });

    const delivery = await deliverFounderNotification(q, event);
    return { ok: true, event, delivery };
  } catch (e) {
    console.warn("[aura-founder] emitFounderEvent:", e?.message || e);
    return { ok: false, reason: e?.message || String(e) };
  }
}

async function deliverFounderNotification(dbQuery, event) {
  const channels = [];
  const { title, body } = buildNotifyCopy(event);
  const founderPhone = founderPhoneE164();
  const email = founderEmail();
  const userIds = await resolveFounderUserIds(dbQuery);

  // 1) In-app
  let inAppOk = false;
  if (userIds.length) {
    for (const userId of userIds) {
      try {
        await dbQuery(
          `INSERT INTO admin_user_notifications (user_id, kind, title, body, payload)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
          [
            userId,
            String(event.event_type || "founder_ops").slice(0, 64),
            title,
            body,
            JSON.stringify({
              eventId: event.id,
              bookingId: event.booking_id,
              eventType: event.event_type,
              actionRequired: event.action_required,
            }),
          ],
        );
        inAppOk = true;
      } catch (e) {
        await logNotification(dbQuery, {
          eventId: event.id,
          channel: "in_app",
          target: userId,
          ok: false,
          reason: e?.message || String(e),
        });
      }
    }
  }
  await logNotification(dbQuery, {
    eventId: event.id,
    channel: "in_app",
    target: userIds.join(",") || "none",
    ok: inAppOk,
    skipped: !userIds.length,
    reason: userIds.length ? (inAppOk ? "sent" : "failed") : "no_founder_user_ids",
  });
  channels.push({ channel: "in_app", ok: inAppOk, skipped: !userIds.length });
  await recordFounderActivity(dbQuery, {
    eventKind: "founder_notification_sent",
    ok: inAppOk,
    detail: { channel: "in_app", eventId: event.id },
  });

  // 2) Push
  let pushOk = false;
  if (userIds.length && pushNotifier?.sendPushToUsers) {
    try {
      const push = await pushNotifier.sendPushToUsers({
        dbQuery,
        userIds,
        kind: "admin_alert",
        title,
        body,
        data: {
          type: "founder_ops",
          eventId: String(event.id),
          bookingId: event.booking_id ? String(event.booking_id) : null,
        },
      });
      pushOk = Boolean(push?.sent > 0 || push?.ok);
      await logNotification(dbQuery, {
        eventId: event.id,
        channel: "push",
        target: userIds.join(","),
        ok: pushOk,
        skipped: !(push?.eligible > 0 || push?.sent > 0),
        reason: pushOk ? "sent" : "no_tokens_or_prefs",
        detail: push,
      });
    } catch (e) {
      await logNotification(dbQuery, {
        eventId: event.id,
        channel: "push",
        target: userIds.join(","),
        ok: false,
        reason: e?.message || String(e),
      });
    }
  } else {
    await logNotification(dbQuery, {
      eventId: event.id,
      channel: "push",
      target: "none",
      ok: false,
      skipped: true,
      reason: "no_founder_user_ids",
    });
  }
  channels.push({ channel: "push", ok: pushOk });
  await recordFounderActivity(dbQuery, {
    eventKind: "founder_notification_sent",
    ok: pushOk,
    detail: { channel: "push", eventId: event.id },
  });

  // 3) Email
  let emailOk = false;
  try {
    const mail = await sendEmail({
      to: email,
      subject: title,
      text: `${body}\n\nPlatform: ${FOUNDER_IDENTITY.platform}\nEvent: ${event.event_type}\nTime: ${event.created_at || new Date().toISOString()}`,
      html: `<p>${body}</p><p>Event: <code>${event.event_type}</code></p>`,
    });
    emailOk = Boolean(mail?.ok || mail?.id || !mail?.error);
    await logNotification(dbQuery, {
      eventId: event.id,
      channel: "email",
      target: email,
      ok: emailOk,
      skipped: false,
      reason: emailOk ? "sent" : mail?.error || "email_failed",
    });
  } catch (e) {
    await logNotification(dbQuery, {
      eventId: event.id,
      channel: "email",
      target: email,
      ok: false,
      reason: e?.message || String(e),
    });
  }
  channels.push({ channel: "email", ok: emailOk });
  await recordFounderActivity(dbQuery, {
    eventKind: "founder_notification_sent",
    ok: emailOk,
    detail: { channel: "email", eventId: event.id },
  });

  // 4) SMS — only when transactional SMS flag permits; never From founder handset
  let smsOk = false;
  let smsSkipped = true;
  if (!isSmsNotificationsEnabled()) {
    await logNotification(dbQuery, {
      eventId: event.id,
      channel: "sms",
      target: founderPhone,
      ok: false,
      skipped: true,
      reason: "sms_notifications_disabled_a2p",
    });
  } else {
    smsSkipped = false;
    try {
      const sms = await sendTransactionalSms(dbQuery, {
        to: founderPhone,
        body: `${title}: ${body}`.slice(0, 320),
        category: "system",
        idempotencyKey: `founder_evt:${event.id}:sms`,
        // Messaging Service / business line — never founder private number as sender
        metadata: {
          founderNotify: true,
          fromPolicy: "messaging_service_or_business_line",
          businessLine: getOfficialAuraBusinessE164(),
        },
      });
      smsOk = Boolean(sms?.ok && !sms?.skipped);
      await logNotification(dbQuery, {
        eventId: event.id,
        channel: "sms",
        target: founderPhone,
        ok: smsOk,
        skipped: Boolean(sms?.skipped),
        reason: sms?.reason || (smsOk ? "sent" : "sms_failed"),
        detail: { sid: sms?.sid || null },
      });
    } catch (e) {
      await logNotification(dbQuery, {
        eventId: event.id,
        channel: "sms",
        target: founderPhone,
        ok: false,
        reason: e?.message || String(e),
      });
    }
  }
  channels.push({ channel: "sms", ok: smsOk, skipped: smsSkipped });
  await recordFounderActivity(dbQuery, {
    eventKind: "founder_notification_sent",
    ok: smsOk,
    detail: { channel: "sms", eventId: event.id, skipped: smsSkipped },
  });

  return { channels, title, body };
}

module.exports = {
  emitFounderEvent,
  deliverFounderNotification,
  resolveFounderUserIds,
};
