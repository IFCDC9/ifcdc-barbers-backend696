import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

try {
  writeFileSync("DEPLOY_COMMIT.txt", execSync("git rev-parse HEAD", { encoding: "utf8" }).trim());
} catch (e) {
  console.warn("[build] DEPLOY_COMMIT.txt skipped", e.message);
}
console.log("[build] backend ready");
