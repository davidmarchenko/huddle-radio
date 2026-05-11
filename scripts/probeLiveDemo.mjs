#!/usr/bin/env node
/**
 * One-off browser probe of the live production deploy.
 *
 * Drives the same golden-path Playwright spec exercises locally, but
 * against the public URL so we know the demo actually works for a
 * visitor (not just that the routes return 200 to curl).
 *
 *   node scripts/probeLiveDemo.mjs [optional-url]
 */

import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "https://huddle-radio.vercel.app";
const consoleErrors = [];
const networkFailures = [];

console.log(`[probe] Launching Chromium → ${url}`);
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
});
const context = await browser.newContext({
  permissions: ["microphone"]
});
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("requestfailed", (req) => {
  networkFailures.push(`${req.method()} ${req.url()} → ${req.failure()?.errorText ?? "unknown"}`);
});

const checks = [];
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  [ok] ${label}`);
    checks.push({ label, ok: true });
  } catch (error) {
    console.log(`  [fail] ${label}: ${error.message?.slice(0, 200)}`);
    checks.push({ label, ok: false, error: error.message });
  }
};

await page.goto(url, { waitUntil: "domcontentloaded" });

await check("home page mounts", async () => {
  await page.waitForSelector("button:has-text('Listen to a sample')", { timeout: 15_000 });
});

await check("clicking 'Listen to a sample' starts a show", async () => {
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  await page.waitForSelector("button:has-text('Stop show')", { timeout: 30_000 });
});

await check("commentary host turn appears in the rail", async () => {
  // The audio-live UI mounts a "Host conversation" panel that fills
  // with article cards as commentary lands.
  await page.waitForSelector("text=/host conversation/i", { timeout: 30_000 });
  const hostTurns = page.locator("article", { has: page.locator("strong") });
  await hostTurns.first().waitFor({ timeout: 30_000 });
});

await check("Cue host push-to-talk button mounts", async () => {
  await page.waitForSelector("button:has-text('Cue host')", { timeout: 30_000 });
});

await browser.close();

const passed = checks.filter((c) => c.ok).length;
const failed = checks.length - passed;
console.log(`\n[probe] ${passed}/${checks.length} checks passed.`);

const fatalConsole = consoleErrors.filter((line) =>
  !line.toLowerCase().includes("hydration") &&
  !line.includes("404") &&
  !line.includes("favicon") &&
  !line.toLowerCase().includes("failed to load resource")
);
if (fatalConsole.length) {
  console.log(`\n[probe] Unexpected console errors (${fatalConsole.length}):`);
  for (const line of fatalConsole.slice(0, 5)) console.log(`  - ${line.slice(0, 200)}`);
}
if (networkFailures.length) {
  const noisy = networkFailures.filter(
    (l) => !l.includes("favicon") && !l.includes("/_next/") && !l.includes("__nextjs_")
  );
  if (noisy.length) {
    console.log(`\n[probe] Network failures (${noisy.length}):`);
    for (const line of noisy.slice(0, 8)) console.log(`  - ${line.slice(0, 200)}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
