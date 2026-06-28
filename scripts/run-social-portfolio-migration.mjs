#!/usr/bin/env node
/** Run V2 portfolio schema migration (idempotent). Usage: node scripts/run-social-portfolio-migration.mjs */
import "../loadBackendEnv.mjs";
import { ensureSocialPortfolioSchema } from "../socialPortfolioMigrations.js";

await ensureSocialPortfolioSchema();
console.log("[migrate] social portfolio schema applied.\n");
