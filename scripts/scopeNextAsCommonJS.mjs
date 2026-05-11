#!/usr/bin/env node
/**
 * Postbuild fix for Vercel + Next.js 16 + Turbopack + `"type":"module"`.
 *
 * Vercel's Function launcher (`___next_launcher.cjs`) loads each
 * route's compiled `route.js` via `require()`. When the project's
 * outer `package.json` declares `"type":"module"`, Node treats those
 * `.js` files as ESM and refuses the `require()` with
 *
 *   Error: require() of ES Module .../route.js from ___next_launcher.cjs
 *   not supported.  ERR_REQUIRE_ESM
 *
 * The fix Node itself recommends: place a `package.json` with
 * `"type":"commonjs"` in the same scope as the `.js` files. Doing
 * that at `.next/server/` re-scopes every route + chunk file as CJS
 * for the deployment, while leaving the project's outer
 * `package.json` (which Next, Vitest, and tsx all rely on) untouched.
 *
 * Idempotent: safe to re-run after `next build`.
 */
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(".next/server/package.json");
if (!existsSync(resolve(".next/server"))) {
  console.warn("[scope-cjs] .next/server missing — did `next build` run?");
  process.exit(0);
}
writeFileSync(target, JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
console.log(`[scope-cjs] Wrote ${target} (type: commonjs).`);
