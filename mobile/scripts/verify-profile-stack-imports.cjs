#!/usr/bin/env node
"use strict";
/**
 * Guard against Profile tab crash: every component={FooScreen} in ProfileStack must be imported.
 */
const fs = require("fs");
const path = require("path");

const stackPath = path.join(__dirname, "..", "navigation", "ProfileStack.tsx");
const src = fs.readFileSync(stackPath, "utf8");

const importNames = new Set(
  [...src.matchAll(/^import\s+(\w+)\s+from/gm)].map((m) => m[1]),
);
const spreadImports = [...src.matchAll(/^import\s+\{\s*([^}]+)\s*\}/gm)].flatMap((m) =>
  m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()),
);
spreadImports.forEach((n) => importNames.add(n));

const used = [...src.matchAll(/component=\{([A-Z]\w*)\}/g)].map((m) => m[1]);
const missing = used.filter((name) => !importNames.has(name));

if (missing.length) {
  console.error("[profile-stack] Missing imports for:", missing.join(", "));
  process.exit(1);
}

console.log("[profile-stack] OK — all", used.length, "stack screen components are imported.");
