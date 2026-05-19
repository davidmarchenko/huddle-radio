import { expect, test } from "@playwright/test";

/**
 * End-to-end proof that the pause button reaches the server engine.
 *
 * We've already got vitest coverage that ShowEngine.setPaused()
 * short-circuits the tick loop. What this spec adds is the missing
 * piece: the browser actually POSTs /api/live/pause when the
 * listener taps Pause, and again with paused=false on Resume. Until
 * this lands, a regression in the client wiring (forgotten import,
 * stale ref, conditional that swallows the call) would silently
 * leave the engine ticking and burning credits in prod — same bug
 * we shipped the pause feature to fix.
 *
 * Strategy: install a Playwright network listener on
 * /api/live/pause requests, drive the UI, then assert the captured
 * bodies match {paused: true} → {paused: false}.
 */
test("clicking pause posts /api/live/pause with the right flag, twice", async ({ page }) => {
  test.setTimeout(120_000);

  const pausePosts: { paused?: boolean; sessionId?: string }[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/live/pause")) return;
    if (request.method() !== "POST") return;
    try {
      const body = request.postDataJSON() as { paused?: boolean; sessionId?: string };
      pausePosts.push(body);
    } catch {
      // body might not be JSON in some unexpected case — still
      // record an empty entry so we know the call was attempted.
      pausePosts.push({});
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  // Wait for live phase — captions appearing is the proof that the
  // engine started producing commentary AND the session is open.
  await expect(page.locator(".player-captions .live-transcript-word").first()).toBeVisible({
    timeout: 45_000
  });

  // Click the play/pause button (label is "Pause show" while live).
  // The button is the primary affordance on the floating player bar.
  const pauseButton = page.getByRole("button", { name: /pause show/i }).first();
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();

  // Give the fire-and-forget POST a moment to hit the wire.
  await expect.poll(() => pausePosts.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  expect(pausePosts[0].paused).toBe(true);
  expect(typeof pausePosts[0].sessionId).toBe("string");
  expect(pausePosts[0].sessionId!.length).toBeGreaterThan(0);

  // After pausing, the same button relabels to "Resume show".
  const resumeButton = page.getByRole("button", { name: /resume show/i }).first();
  await expect(resumeButton).toBeVisible();
  await resumeButton.click();

  // Second POST with paused=false.
  await expect.poll(() => pausePosts.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  expect(pausePosts[1].paused).toBe(false);
  expect(pausePosts[1].sessionId).toBe(pausePosts[0].sessionId);
});
