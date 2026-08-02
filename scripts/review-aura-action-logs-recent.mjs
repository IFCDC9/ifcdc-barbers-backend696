import { dbQuery } from "../db.js";

const recent = await dbQuery(
  `SELECT created_at, action, result, metadata
   FROM aura_action_logs
   WHERE created_at > NOW() - INTERVAL '30 minutes'
   ORDER BY created_at DESC
   LIMIT 20`,
);
const adminHour = await dbQuery(
  `SELECT metadata->>'kind' AS kind, result, COUNT(*)::int AS c
   FROM aura_action_logs
   WHERE action = 'admin_alert'
     AND created_at > NOW() - INTERVAL '60 minutes'
   GROUP BY 1, 2
   ORDER BY MAX(created_at) DESC`,
);

console.log(
  JSON.stringify(
    {
      recentActions: recent.rows,
      adminAlertKindsLastHour: adminHour.rows,
    },
    null,
    2,
  ),
);
