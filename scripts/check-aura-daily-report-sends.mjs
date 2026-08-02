#!/usr/bin/env node
import { dbQuery } from "../db.js";

const sent = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = $1 AND result = $2`,
  ["daily_report_send", "sent"],
);
const recent = await dbQuery(
  `SELECT id::text AS id, result, metadata, created_at
   FROM aura_action_logs
   WHERE action = $1
   ORDER BY created_at DESC
   LIMIT 5`,
  ["daily_report_send"],
);
const since = await dbQuery(
  `SELECT COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = $1 AND result = $2 AND created_at > NOW() - INTERVAL '30 minutes'`,
  ["daily_report_send", "sent"],
);

console.log(
  JSON.stringify(
    {
      sentTotal: sent.rows[0].c,
      sentLast30m: since.rows[0].c,
      recent: recent.rows,
    },
    null,
    2,
  ),
);
process.exit(0);
