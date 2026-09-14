
import express from "express"
import db from "../db/db.js"
import { requireAdmin } from "../middleware/requireAdmin.js"
import { listSubscriptions } from "../services/subscriptionService.js"
import { legacyWriteFrozenPayload } from "../../legacySubscriptionFreeze.js"

const router = express.Router()

// 📊 GET DASHBOARD SUMMARY (admin protected)
router.get("/summary", requireAdmin, async (req, res) => {
  try {
    // Check if bookings table has status and price columns
    const bookingColumns = await getColumnNames("bookings");
    const hasStatus = bookingColumns.has("status");
    const hasPrice = bookingColumns.has("price");

    let select = "COUNT(*) AS total_bookings";
    if (hasStatus) {
      select += ", COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_bookings";
      select += ", COUNT(*) FILTER (WHERE status = 'pending') AS pending_bookings";
    } else {
      select += ", 0 AS confirmed_bookings, 0 AS pending_bookings";
    }
    if (hasStatus && hasPrice) {
      select += ", COALESCE(SUM(price) FILTER (WHERE status = 'confirmed'), 0) AS total_revenue";
    } else {
      select += ", 0 AS total_revenue";
    }

    const result = await db.query(`SELECT ${select} FROM bookings`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Admin summary error:", err);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

async function getColumnNames(tableName) {
  const result = await db.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
    `,
    [tableName]
  )

  return new Set(result.rows.map((row) => row.column_name))
}

function selectOrNull(columns, expression, alias, nullType = "text") {
  return columns.has(alias) ? expression : `NULL::${nullType} AS ${alias}`
}


// 📊 GET ALL BOOKINGS + CUSTOMER INFO (admin protected)
router.get("/bookings", requireAdmin, async (req, res) => {
  try {
    const [bookingColumns, customerColumns] = await Promise.all([
      getColumnNames("bookings"),
      getColumnNames("customers"),
    ])

    const hasCustomerJoin = bookingColumns.has("customer_id")
    const serviceSelect = selectOrNull(bookingColumns, "b.service", "service")
    const dateSelect = selectOrNull(bookingColumns, "b.date", "date", "date")
    const timeSelect = selectOrNull(bookingColumns, "b.time", "time", "time")
    const statusSelect = selectOrNull(bookingColumns, "b.status", "status")
    const priceSelect = selectOrNull(bookingColumns, "b.price", "price", "numeric")
    const nameSelect = hasCustomerJoin && customerColumns.has("name") ? "c.name" : "NULL::text AS name"
    const phoneSelect = hasCustomerJoin && customerColumns.has("phone") ? "c.phone" : "NULL::text AS phone"
    const emailSelect = hasCustomerJoin && customerColumns.has("email") ? "c.email" : "NULL::text AS email"
    const customerJoin = hasCustomerJoin ? "LEFT JOIN customers c ON b.customer_id = c.id" : ""

    const result = await db.query(`
      SELECT
        b.id,
        ${serviceSelect},
        ${dateSelect},
        ${timeSelect},
        ${statusSelect},
        ${priceSelect},
        ${nameSelect},
        ${phoneSelect},
        ${emailSelect}
      FROM bookings b
      ${customerJoin}
      ORDER BY b.date DESC, b.time DESC
    `)

    res.json(result.rows)
  } catch (err) {
    console.error("❌ Admin fetch error:", err)
    res.status(500).json({ error: "Failed to fetch bookings" })
  }
})

// 💳 SUBSCRIPTIONS (admin protected)
router.get("/subscriptions", requireAdmin, async (req, res) => {
  try {
    const activeOnly = String(req.query.activeOnly || "").trim() === "true"
    const subs = await listSubscriptions({ activeOnly })
    res.json({ ok: true, subscriptions: subs })
  } catch (err) {
    console.error("❌ Admin subscriptions error:", err)
    res.status(500).json({ ok: false, error: "failed_to_fetch_subscriptions" })
  }
})

router.post("/subscriptions/:barberId/start-trial", requireAdmin, async (req, res) => {
  return res.status(410).json(legacyWriteFrozenPayload("sevenDayStartTrial"))
})

router.post("/subscriptions/:barberId/activate-monthly", requireAdmin, async (req, res) => {
  return res.status(410).json(legacyWriteFrozenPayload("activateMonthly"))
})

export default router
