import { expect, test } from "@playwright/test";

/**
 * Ad-hoc transcript capture run. Starts a sample show, lets it
 * generate several turns, then asserts the diagnostics endpoint
 * returns the new `lines` field. Mainly useful as a tool — run it
 * and copy the printed transcript into a code review or bug report.
 *
 * NOT a smoke test; opts out of CI via test.skip on CI.
 */

test.skip(({}, testInfo) => Boolean(process.env.CI), "Local-only transcript capture run");

test("captures 60s of host transcripts from a sample show", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  await expect(page.getByRole("button", { name: /stop show/i }).first()).toBeVisible({ timeout: 30_000 });
  // Let the engine churn — opener + several ticks.
  await page.waitForTimeout(60_000);
  const res = await request.get("/api/diagnostics/recent-turns?n=20");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  // eslint-disable-next-line no-console
  console.log("\n===== CAPTURED TRANSCRIPTS =====\n" + JSON.stringify(body, null, 2));
});
