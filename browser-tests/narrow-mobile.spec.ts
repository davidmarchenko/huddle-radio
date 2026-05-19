import { expect, test } from "@playwright/test";

/**
 * Player-bar overflow check on a 320px-wide viewport (original iPhone
 * SE / Galaxy Fold cover screen). Pixel 5 emulation is 393px wide,
 * which has more give. Narrow viewports historically broke the audio
 * footer because the captions + host stack + buttons couldn't all
 * fit in one row and a child without min-width:0 forced horizontal
 * scroll.
 *
 * Passing means:
 *   - The page mounts.
 *   - Tapping "Listen to a sample" actually starts a show.
 *   - The .huddle-player floor stays inside the viewport (no
 *     horizontal scroll into negative space, no right-edge clipping).
 */
test.use({
  viewport: { width: 320, height: 568 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15",
  permissions: ["microphone"]
});

test("narrow mobile (320px) — player bar stays inside the viewport", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();

  const sample = page.getByRole("button", { name: /listen to a sample/i }).first();
  await expect(sample).toBeVisible();
  await sample.click();

  await expect(page.locator(".player-captions").first()).toBeVisible({ timeout: 45_000 });

  const viewport = page.viewportSize();
  expect(viewport, "viewport set").not.toBeNull();
  // Walk the player floor and its primary children. If anything
  // extends past the viewport edge, narrow-mobile is broken.
  const playerBox = await page.locator(".huddle-player").first().boundingBox();
  expect(playerBox, "player floor has bounding box").not.toBeNull();
  if (playerBox) {
    expect(playerBox.x, "player floor x must be ≥ 0").toBeGreaterThanOrEqual(-1);
    expect(
      playerBox.x + playerBox.width,
      "player floor right edge must stay within viewport"
    ).toBeLessThanOrEqual(viewport!.width + 1);
  }
  // Body should not have a horizontal scrollbar — that's the
  // classic "child overflowed" symptom.
  const horizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(horizontalScroll, "no horizontal page scroll on narrow mobile").toBe(false);
});
