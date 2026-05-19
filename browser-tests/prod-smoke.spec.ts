import { expect, test } from "@playwright/test";

/**
 * End-to-end deploy verification. Run with PLAYWRIGHT_BASE_URL set
 * to a Vercel deployment to confirm the show actually works for a
 * real listener — no human needed.
 *
 *   npm run test:browser:prod
 *   PLAYWRIGHT_BASE_URL=https://preview-xxx.vercel.app npx playwright test browser-tests/prod-smoke.spec.ts
 *
 * Asserts on user-visible behavior only — does NOT depend on the
 * /api/diagnostics ring buffer, which is per-Fluid-Compute-instance
 * and won't see SSE traffic that landed on a different instance.
 *
 * Each assertion is intentionally what a real listener would notice:
 *   1. The page loads without fatal console errors.
 *   2. Clicking "Listen to a sample" actually starts a show.
 *   3. Captions mount with text (proves commentary lands).
 *   4. The audio level meter pulses (proves TTS audio is reaching
 *      the client and playing back — pulses are driven by the
 *      audio-element's measured loudness).
 *
 * If all four hold, the deploy is good. Any failure tells us what
 * specifically broke — opening the trace.zip from the run shows
 * the page state at the moment of failure.
 */
test("deploy smoke — sample show plays end-to-end", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.goto("/");

  // 1. Page mounted clean.
  await expect(page.locator("body")).toBeVisible();

  // 2. Sample show starts.
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  await expect(page.getByRole("button", { name: /stop show/i }).first()).toBeVisible({
    timeout: 30_000
  });

  // 3. Captions mount with rendered text. The slot only appears when
  //    commentary.length > 0; the word elements only render when
  //    the commentary turn has text. Both together = the engine
  //    drafted and delivered at least one turn.
  const captions = page.locator(".player-captions").first();
  await expect(captions).toBeVisible({ timeout: 30_000 });
  const firstWord = captions.locator(".live-transcript-word").first();
  await expect(firstWord).toBeVisible({ timeout: 30_000 });
  const captionText = (await firstWord.textContent())?.trim() ?? "";
  expect(captionText.length).toBeGreaterThan(0);

  // 4. Audio is playing. The Waveform component gets `.is-playing`
  //    on its parent div whenever the engine is producing TTS audio
  //    AND the audio element has started playback. Captions can
  //    mount on text alone (5-15s ahead of TTS first byte), so this
  //    check is the layered proof that TTS audio actually reached
  //    the listener — not just text. Use toHaveCount() rather than
  //    toBeVisible() because the waveform is aria-hidden="true"
  //    (decorative) and Playwright treats aria-hidden as not visible.
  await expect(page.locator(".waveform.is-playing")).not.toHaveCount(0, { timeout: 45_000 });

  // No fatal console errors during the run. Filter benign warnings
  // (third-party iframe noise, etc.) by requiring "error" in the
  // text — but in practice any unhandled exception is what we'd
  // want to catch here.
  const fatal = consoleErrors.filter((e) => /Uncaught|TypeError|ReferenceError/.test(e));
  expect(fatal, `console fatals: ${fatal.join(" | ")}`).toHaveLength(0);
});
