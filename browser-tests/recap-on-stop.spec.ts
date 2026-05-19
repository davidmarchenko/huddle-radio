import { expect, test } from "@playwright/test";

/**
 * Locks the Stop → Recap → Back-to-discover flow.
 *
 * Pre-fix: clicking "Stop show" cleared commentary state AND
 * navigated back to "/", so listeners who just heard 60s of a
 * sample were dumped to discover with no acknowledgment of what
 * they'd just experienced. The product gap: recap was technically
 * implemented but unreachable from the demo flow.
 *
 * Post-fix: Stop closes the SSE session (engine stops, credits
 * preserved) but keeps commentary state alive, so phase flips to
 * "recap" and the listener sees a summary card with host
 * transcript, turning point, show stats, and an explicit "Back to
 * discover" exit button.
 *
 * Each assertion is what a real listener would notice:
 *   1. Sample show starts and produces commentary.
 *   2. Stop button takes them OUT of live but INTO recap (not back
 *      to discover empty-handed).
 *   3. Recap shows >= 1 generated call in its show-stats card.
 *   4. "Back to discover" exits cleanly to home.
 */
test("Stop → Recap → Back to discover preserves what the listener heard", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  // Wait until at least one commentary turn lands. Captions
  // appearing is the proof — the player-captions slot only renders
  // when commentary.length > 0.
  await expect(page.locator(".player-captions .live-transcript-word").first()).toBeVisible({
    timeout: 45_000
  });
  // Click Stop. Multiple Stop buttons exist on the page (player bar,
  // possibly the rail) — .first() picks whichever is visible first.
  await page.getByRole("button", { name: /stop show/i }).first().click();
  // The recap layout should appear (NOT discover). This is the
  // whole point of the fix.
  const recap = page.locator(".recap-layout");
  await expect(recap).toBeVisible({ timeout: 15_000 });
  // Show stats card proves commentary was preserved — pre-fix,
  // stopLivecast cleared commentary[] so this would show "0".
  // Text shape after the buildShowStatsLines rewrite:
  //   "6 calls across 5 minutes of show." (multi-turn)
  //   "1 call in this show."              (single turn)
  const showStats = recap.getByText(/\d+ calls? (across|in)/i).first();
  await expect(showStats).toBeVisible();
  const statsText = (await showStats.textContent())?.trim() ?? "";
  const callCountMatch = statsText.match(/^(\d+)/);
  const callCount = callCountMatch ? Number(callCountMatch[1]) : 0;
  expect(callCount, `recap shows ${callCount} calls; expected >= 1`).toBeGreaterThanOrEqual(1);
  // "Back to discover" exits to home cleanly. This is the explicit
  // post-recap exit the fix introduces — recap is no longer a
  // dead-end.
  const backButton = page.getByRole("button", { name: /back to discover/i });
  await expect(backButton).toBeVisible();
  await backButton.click();
  // After exit, recap is gone AND the discover surface is visible.
  await expect(recap).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /listen to a sample/i }).first()).toBeVisible();
});
