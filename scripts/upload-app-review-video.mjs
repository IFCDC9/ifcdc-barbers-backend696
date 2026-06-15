#!/usr/bin/env node
/**
 * Upload App Review demo video to Supabase public storage.
 * Usage: node --import ./loadBackendEnv.mjs scripts/upload-app-review-video.mjs [path-to.mp4]
 */
import fs from "node:fs";
import path from "node:path";
import { getSupabaseServiceClient } from "../src/db/supabaseServiceClient.js";

const input =
  process.argv[2] ||
  path.join(
    process.env.HOME || "",
    "Downloads",
    "ScreenRecording_06-15-2026 09-39-53_1.MP4",
  );

const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || "barber-styles").trim();
const objectKey = "app-review/account-deletion-demo-build36.mp4";

async function main() {
  if (!fs.existsSync(input)) {
    throw new Error(`Video not found: ${input}`);
  }
  const stat = fs.statSync(input);
  console.log(`[upload] ${input} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

  const client = getSupabaseServiceClient();
  if (!client) {
    throw new Error("Supabase service client not configured");
  }

  const body = fs.readFileSync(input);
  const { data, error } = await client.storage.from(bucket).upload(objectKey, body, {
    contentType: "video/mp4",
    upsert: true,
    cacheControl: "3600",
  });
  if (error) {
    throw new Error(error.message || "upload failed");
  }

  const { data: pub } = client.storage.from(bucket).getPublicUrl(data.path);
  const url = pub?.publicUrl;
  if (!url) {
    throw new Error("Could not resolve public URL");
  }

  console.log(JSON.stringify({ ok: true, bucket, path: data.path, publicUrl: url }, null, 2));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
