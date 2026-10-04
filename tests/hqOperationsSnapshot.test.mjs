/**
 * HQ read snapshot auth. Fixture token only. No production network and no booking writes.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createBookingsAdminGuard } from "../bookingsAdminGuard.js";
import { createAdminUsersRouter } from "../adminUsersRoutes.js";
import { createBookingsRouter } from "../bookingsRoutes.js";
import {
  buildHqOperationsSnapshot,
  createHqOperationsSnapshotRouter,
  HQ_SNAPSHOT_READ_TOKEN_ENV,
} from "../hqOperationsSnapshot.js";
import { readFileSync } from "node:fs";

const FIXTURE_TOKEN = randomBytes(32).toString("hex");
const FIXTURE_ADMIN = randomBytes(32).toString("hex");

function listen(app) {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

async function call(port, method, path, headers = {}, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json };
}

function fixtureSnapshot() {
  return buildHqOperationsSnapshot({
    now: "2026-10-04T15:00:00.000Z",
    bookings: [
      {
        date: "2026-10-04",
        time: "10:00 AM",
        barber_name: "Alex",
        service: "Haircut",
        booking_status: "confirmed",
        shop_name: "Main",
        customer_email: "hidden@example.com",
        phone: "555-0100",
      },
      {
        date: "2026-10-06",
        time: "11:00 AM",
        barber_name: "Alex",
        service: "Beard",
        booking_status: "confirmed",
        shop_name: "Main",
      },
      {
        date: "2026-10-04",
        time: "12:00 PM",
        barber_name: "Alex",
        service: "Haircut",
        booking_status: "cancelled",
        shop_name: "Main",
      },
      {
        date: "2026-10-07",
        time: "1:00 PM",
        barber_name: "Alex",
        service: "Haircut",
        booking_status: "rescheduled",
        rescheduled_at: "2026-10-01T12:00:00.000Z",
        shop_name: "Main",
      },
    ],
    shops: [{ name: "Main", status: "active", phone: "555-0199" }],
    openings: [
      { date: "2026-10-04", barberName: "Alex", available: 0, reasonIfEmpty: "closed_day", usedFallback: false },
      { date: "2026-10-05", barberName: "Alex", available: 24, reasonIfEmpty: null, usedFallback: false },
    ],
  });
}

test("snapshot route allows only the HQ read token", async () => {
  process.env[HQ_SNAPSHOT_READ_TOKEN_ENV] = FIXTURE_TOKEN;
  process.env.ADMIN_SECRET = FIXTURE_ADMIN;
  let loads = 0;
  const app = express();
  app.use(express.json());
  app.use("/api/hq", createHqOperationsSnapshotRouter({
    loadSnapshot: async () => {
      loads += 1;
      return fixtureSnapshot();
    },
  }));
  const { server, port } = await listen(app);
  try {
    const missing = await call(port, "GET", "/api/hq/operations-snapshot");
    assert.equal(missing.status, 401);
    assert.equal(loads, 0);

    const adminKey = await call(port, "GET", "/api/hq/operations-snapshot", { "x-admin-key": FIXTURE_ADMIN });
    assert.equal(adminKey.status, 401);
    assert.equal(loads, 0);

    const tokenAsAdmin = await call(port, "GET", "/api/hq/operations-snapshot", { "x-admin-key": FIXTURE_TOKEN });
    assert.equal(tokenAsAdmin.status, 401);

    const bearer = await call(port, "GET", "/api/hq/operations-snapshot", { authorization: `Bearer ${FIXTURE_TOKEN}` });
    assert.equal(bearer.status, 401);

    const wrong = await call(port, "GET", "/api/hq/operations-snapshot", { "x-ifcdc-hq-read-token": "wrong-token" });
    assert.equal(wrong.status, 401);

    const ok = await call(port, "GET", "/api/hq/operations-snapshot", { "x-ifcdc-hq-read-token": FIXTURE_TOKEN });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.sourceHealth, "ok");
    assert.equal(ok.json.todayBookings.count, 1);
    assert.equal(ok.json.upcomingBookings.count, 1);
    assert.equal(ok.json.cancellations.count, 1);
    assert.equal(ok.json.reschedules.count, 1);
    assert.equal(ok.json.openings.count, 24);
    assert.equal(ok.json.shopStatus.count, 1);
    assert.equal(ok.json.shopStatus.items[0].status, "active");
    const encoded = JSON.stringify(ok.json);
    assert.equal(encoded.includes("hidden@example.com"), false);
    assert.equal(encoded.includes("555-0100"), false);
    assert.equal(encoded.includes("555-0199"), false);
    assert.equal(loads, 1);

    const posted = await call(port, "POST", "/api/hq/operations-snapshot", { "x-ifcdc-hq-read-token": FIXTURE_TOKEN }, { date: "2026-10-04" });
    assert.equal(posted.status, 405);
    assert.equal(loads, 1);
  } finally {
    server.close();
    delete process.env[HQ_SNAPSHOT_READ_TOKEN_ENV];
    delete process.env.ADMIN_SECRET;
  }
});

test("unread sections stay null instead of a fabricated zero", () => {
  const snapshot = buildHqOperationsSnapshot({
    now: "2026-10-04T15:00:00.000Z",
    bookings: null,
    shops: null,
    openings: null,
  });
  assert.equal(snapshot.sourceHealth, "unavailable");
  assert.equal(snapshot.todayBookings.count, null);
  assert.equal(snapshot.todayBookings.status, "not_connected");
  assert.equal(snapshot.shopStatus.count, null);
  assert.equal(snapshot.openings.count, null);
  assert.equal(snapshot.refreshedAt, null);
});

test("read credential is denied by booking, cancel, reschedule, and admin routes", async () => {
  process.env[HQ_SNAPSHOT_READ_TOKEN_ENV] = FIXTURE_TOKEN;
  process.env.ADMIN_SECRET = FIXTURE_ADMIN;
  const app = express();
  app.use(express.json());
  const adminGuard = createBookingsAdminGuard({
    resolveAuthPayload: () => null,
    dbQuery: async () => { throw new Error("admin query must not run"); },
  });
  app.use(createBookingsRouter({
    sendBookingEmail: async () => { throw new Error("mail must not send"); },
    sendBookingPush: async () => { throw new Error("push must not send"); },
    requireAdmin: adminGuard,
  }));
  app.use(createAdminUsersRouter({
    sendEmail: async () => { throw new Error("mail must not send"); },
  }));

  const header = { "x-ifcdc-hq-read-token": FIXTURE_TOKEN };
  const { server, port } = await listen(app);
  try {
    const cancel = await call(port, "POST", "/api/bookings/00000000-0000-4000-8000-000000000099/cancel", header, { reason: "test" });
    const reschedule = await call(port, "POST", "/api/bookings/00000000-0000-4000-8000-000000000099/reschedule", header, { date: "2026-10-05", time: "10:00 AM" });
    const adminPatch = await call(port, "PATCH", "/api/admin/bookings/00000000-0000-4000-8000-000000000099", header, { action: "cancel" });
    const adminDelete = await call(port, "DELETE", "/api/admin/bookings/00000000-0000-4000-8000-000000000099", header);
    const roleChange = await call(port, "PUT", "/api/admin/user-role", header, { userId: "00000000-0000-4000-8000-000000000099", role: "admin" });

    assert.equal(cancel.status, 401);
    assert.equal(reschedule.status, 401);
    assert.equal(adminPatch.status, 401);
    assert.equal(adminDelete.status, 401);
    assert.equal(roleChange.status, 401);
    assert.notEqual(cancel.json?.wrote, true);
    assert.notEqual(adminPatch.json?.wrote, true);
  } finally {
    server.close();
    delete process.env[HQ_SNAPSHOT_READ_TOKEN_ENV];
    delete process.env.ADMIN_SECRET;
  }
});

test("write and admin middleware do not allow the HQ read token", () => {
  const bookingsSource = readFileSync(new URL("../bookingsRoutes.js", import.meta.url), "utf8");
  const adminSource = readFileSync(new URL("../bookingsAdminGuard.js", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  for (const source of [bookingsSource, adminSource]) {
    assert.equal(source.includes("x-ifcdc-hq-read-token"), false);
    assert.equal(source.includes("BARBERS_HQ_SNAPSHOT_READ_TOKEN"), false);
  }
  assert.equal(bookingsSource.includes('router.post("/api/bookings/:id/cancel", requireAuth'), true);
  assert.equal(bookingsSource.includes('router.post("/api/bookings/:id/reschedule", requireAuth'), true);
  assert.equal(serverSource.includes("createHqOperationsSnapshotRouter"), true);
  assert.equal(serverSource.includes("x-ifcdc-hq-read-token"), false);
});
