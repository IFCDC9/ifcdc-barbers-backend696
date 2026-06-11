#!/usr/bin/env node
/**
 * Export production Postgres schema + data before security migrations.
 * Usage: node --import ./loadBackendEnv.mjs scripts/backup-supabase-db.mjs
 */
import "../loadBackendEnv.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function stripSslQueryFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return urlString;
  }
}

const url = stripSslQueryFromUrl(String(process.env.DATABASE_URL || "").trim());
if (!url) {
  console.error("DATABASE_URL missing — cannot create backup.");
  process.exit(1);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backupDir = path.join(root, "backups");
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(backupDir, `supabase-vtkxuagevtiwtoheomjt-${stamp}.sql`);

console.log(`Backing up ${new URL(url).hostname} → ${outFile}`);

const result = spawnSync(
  "pg_dump",
  [
    "--dbname",
    url,
    "--no-owner",
    "--no-acl",
    "--format=plain",
    "--file",
    outFile,
  ],
  {
    env: { ...process.env, PGSSLMODE: "require" },
    encoding: "utf8",
  }
);

if (result.status !== 0) {
  console.error("pg_dump failed:", result.stderr || result.stdout || "unknown error");
  console.error("Install PostgreSQL client tools (pg_dump) if missing.");
  process.exit(1);
}

const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
console.log(`✓ Backup complete (${sizeMb} MB): ${outFile}`);
