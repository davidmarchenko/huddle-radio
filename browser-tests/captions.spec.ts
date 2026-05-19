import { expect, test } from "@playwright/test";

/**
 * Locks the regression we just fixed: captions must mount during
 * live-audio playback. Previously the gate was
 * `playedLineKeys.size > 0`, which only flipped true once the FIRST
 * TTS chunk had played back — meaning the listener stared at a blank
 * bar through 5-15s of ElevenLabs first-byte latency. The gate is
 * now `commentary.length > 0`, so the captions slot appears the
 * moment the engine emits its first commentary turn (text arrives
 * 5-15s before audio in the LLM path).
 *
 * Strategy: click "Listen to a sample", wait for the audio-live
 * phase, then wait for .player-captions to mount with non-empty
 * text content. We use a generous timeout because mock-mode
 * commentary still takes a couple seconds to land.
 */

test("captions slot mounts with visible text once commentary arrives", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  // Show has started — Stop button confirms we're in a live phase.
  await expect(page.getByRole("button", { name: /stop show/i }).first()).toBeVisible({
    timeout: 30_000
  });
  // Captions slot mounts when commentary.length > 0. The slot has
  // class .player-captions; the visible text lives inside
  // .player-captions-track > .live-transcript-word elements.
  const captions = page.locator(".player-captions").first();
  await expect(captions).toBeVisible({ timeout: 30_000 });
  // At least one word should be rendered. The element exists even
  // before audio plays back — that's the whole point of the fix.
  const firstWord = captions.locator(".live-transcript-word").first();
  await expect(firstWord).toBeVisible({ timeout: 30_000 });
  // And the rendered text should be non-empty.
  const text = (await firstWord.textContent())?.trim() ?? "";
  expect(text.length).toBeGreaterThan(0);
});
