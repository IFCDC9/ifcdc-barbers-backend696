/**
 * Public Apple PKI roots used to verify App Store Server JWS x5c chains.
 * Source: https://www.apple.com/certificateauthority/
 * These are certificates, not secrets.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

let cached = null;

export function loadAppleRootCertificates() {
  if (cached) return cached;
  cached = [
    readFileSync(join(DIR, "certs", "AppleRootCA-G3.pem")),
    readFileSync(join(DIR, "certs", "AppleRootCA-G2.pem")),
  ];
  return cached;
}
