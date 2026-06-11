#!/usr/bin/env node
/**
 * Smoke-test public service photo resolution (gallery + barber_services cover).
 */
import "../loadBackendEnv.mjs";
import { dbQuery } from "../db.js";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { fetchPublicBarberServices } = requireCjs("../bookingServicesCatalog.cjs");

const BARBER_ID = process.env.VERIFY_BARBER_ID || "3df86e72-8999-4633-bca7-2274b57b5b4f";

async function main() {
  const result = await fetchPublicBarberServices(dbQuery, {
    barberIdRaw: BARBER_ID,
    barberName: "IFCDC Barbers",
  });

  const services = result?.services || [];
  console.log(`[verify-service-photos] barber=${BARBER_ID} services=${services.length}`);

  let missingCover = 0;
  for (const s of services) {
    const cover = String(s.cover_image_url || s.image_url || "").trim();
    const ok = cover.startsWith("https://");
    if (!ok) {
      missingCover += 1;
      console.warn(`  MISSING: id=${s.id} name=${s.name}`);
    } else {
      console.log(`  OK: id=${s.id} name=${s.name} cover=${cover.slice(0, 72)}…`);
    }
  }

  const kids = services.find((s) => /kids/i.test(String(s.name)));
  if (kids) {
    console.log(`[verify-service-photos] Kids Cut cover: ${kids.cover_image_url || kids.image_url || "(none)"}`);
  }

  if (missingCover) {
    console.error(`[verify-service-photos] FAIL — ${missingCover} service(s) without HTTPS cover`);
    process.exit(1);
  }
  console.log("[verify-service-photos] PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
