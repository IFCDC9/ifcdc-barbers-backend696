import { dbQuery } from "../db.js";

const cols = await dbQuery(
  `SELECT column_name
   FROM information_schema.columns
   WHERE table_schema = $1
     AND table_name = $2
     AND column_name = ANY($3::text[])
   ORDER BY 1`,
  ["public", "bookings", ["reminder_sent_at", "reminder_24h_sent_at", "reminder_2h_sent_at"]],
);

const tables = await dbQuery(`SELECT to_regclass($1)::text AS t`, ["public.aura_action_logs"]);
const idx = await dbQuery(
  `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1`,
  ["aura_action_logs"],
);
const counts = await dbQuery(
  `SELECT COUNT(*)::int AS total_bookings,
          COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active_rows,
          COUNT(*) FILTER (WHERE booking_status = 'confirmed')::int AS confirmed
   FROM bookings`,
);

console.log(
  JSON.stringify(
    {
      reminder_columns: cols.rows.map((r) => r.column_name),
      aura_action_logs: tables.rows[0],
      indexes: idx.rows.map((r) => r.indexname),
      bookings: counts.rows[0],
    },
    null,
    2,
  ),
);
