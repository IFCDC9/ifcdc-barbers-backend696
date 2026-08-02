#!/usr/bin/env node
import { createRequire } from "module";
import { dbQuery } from "../db.js";

const require = createRequire(import.meta.url);
const { controlledTestSql, shopTimezone, reportDayBounds } = require("../auraDailyReport.cjs");

const day = "2026-08-02";
const tz = shopTimezone();
const testSql = controlledTestSql();

const onDay = await dbQuery(
  `SELECT COUNT(*)::int AS all_on_day,
          COUNT(*) FILTER (WHERE NOT ${testSql})::int AS prod_on_day,
          COUNT(*) FILTER (WHERE ${testSql})::int AS test_on_day
   FROM bookings WHERE date = $1::date`,
  [day],
);

const upcoming = await dbQuery(
  `SELECT id::text AS id, date::text AS date, to_char(time,'HH12:MI AM') AS time,
          booking_status, left(customer_name,40) AS customer_name,
          left(coalesce(notes,''),60) AS notes_preview
   FROM bookings
   WHERE (
     (date > $1::date
       AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled','no_show','noshow')
       AND NOT ${testSql})
     OR
     (date = $1::date
       AND lower(coalesce(booking_status,'')) NOT IN ('cancelled','canceled','completed','no_show','noshow')
       AND (date + time) > NOW()
       AND NOT ${testSql})
   )
   ORDER BY date, time
   LIMIT 20`,
  [day],
);

const failed = await dbQuery(
  `SELECT id::text AS id, action, result, metadata, created_at
   FROM aura_action_logs
   WHERE (created_at AT TIME ZONE $2)::date = $1::date
     AND (
       lower(coalesce(result,'')) LIKE '%fail%'
       OR action LIKE '%failed%'
       OR action = 'admin_alert'
     )
   ORDER BY created_at ASC`,
  [day, tz],
);

console.log(
  JSON.stringify(
    {
      bounds: reportDayBounds(day),
      onDay: onDay.rows[0],
      upcomingCount: upcoming.rows.length,
      upcoming: upcoming.rows,
      failedEmails: failed.rows,
      envRecipient: {
        AURA_DAILY_REPORT_TO_set: Boolean(String(process.env.AURA_DAILY_REPORT_TO || "").trim()),
        BOOKING_ADMIN_EMAIL: String(process.env.BOOKING_ADMIN_EMAIL || "").trim() || null,
        resolved:
          String(process.env.AURA_DAILY_REPORT_TO || process.env.BOOKING_ADMIN_EMAIL || "").trim() ||
          null,
      },
    },
    null,
    2,
  ),
);
process.exit(0);
