import { execSync } from "node:child_process";
import {
  beautySandboxServeClientEnabled,
  D8UI_API_ORIGIN,
} from "../beautySandboxClientServe.js";

if (!beautySandboxServeClientEnabled()) {
  console.log("[build] beauty sandbox client skipped (not d8ui / flag off)");
  process.exit(0);
}

const env = { ...process.env };
if (!String(env.VITE_API_BASE || "").trim()) {
  env.VITE_API_BASE = D8UI_API_ORIGIN;
}
console.log("[build] building client/dist for d8ui SPA");
execSync("npm install --prefix client", { stdio: "inherit", env });
execSync("npm run build --prefix client", { stdio: "inherit", env });
