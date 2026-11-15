import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** Opt-in d8ui/sandbox only. Unset keeps production API JSON 404 catch-all. */
export function beautySandboxServeClientEnabled(env = process.env) {
  return String(env.BEAUTY_SANDBOX_SERVE_CLIENT || "").trim() === "1";
}

export function resolveClientDistDir({ env = process.env, cwd = process.cwd(), root = repoRoot } = {}) {
  const fromEnv = String(env.CLIENT_DIST_PATH || "").trim();
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (fs.existsSync(path.join(abs, "index.html"))) return abs;
  }
  const candidates = [
    path.join(root, "client", "dist"),
    path.join(cwd, "client", "dist"),
    path.join(root, "client", "build"),
    path.join(cwd, "client", "build"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return path.join(root, "client", "dist");
}

export function clientDistIndexHtml(distDir) {
  return path.join(distDir, "index.html");
}

/**
 * Serve built `client/dist` (including `/admin/beauty-supply` and `/login`) when the sandbox flag is on.
 * `/api/*` is never rewritten to HTML.
 */
export function mountBeautySandboxClient(app, options = {}) {
  const env = options.env || process.env;
  if (!beautySandboxServeClientEnabled(env)) {
    return { enabled: false, clientBuildReady: false, distDir: null };
  }
  const distDir = options.distDir || resolveClientDistDir({ env, cwd: options.cwd, root: options.root });
  const indexHtml = clientDistIndexHtml(distDir);
  const clientBuildReady = fs.existsSync(indexHtml);
  if (!clientBuildReady) {
    return { enabled: true, clientBuildReady: false, distDir };
  }
  app.use(express.static(distDir, { index: "index.html", fallthrough: true }));
  const spaFallback = (req, res, next) => {
    const p = String(req.path || "");
    if (p.startsWith("/api")) return next();
    res.type("html");
    return res.sendFile(path.resolve(indexHtml));
  };
  app.get("*", spaFallback);
  app.head("*", spaFallback);
  return { enabled: true, clientBuildReady: true, distDir };
}
