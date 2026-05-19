import { devices, expect, test } from "@playwright/test";

/**
 * Mobile variant of the prod deploy smoke. Same listener-visible
 * assertions (page mounts, sample show starts, captions render, TTS
 * audio actually plays), but under a Pixel 5 viewport + UA so we
 * catch mobile-specific regressions: tap targets that vanish at
 * narrow widths, layout shifts that hide the play button, audio
 * gestures that fail because we're inside a popup/install prompt.
 *
 * Run against a deployed URL:
 *   PLAYWRIGHT_BASE_URL=https://huddle-radio.vercel.app \
 *     npx playwright test browser-tests/prod-mobile.spec.ts
 *
 * Notes:
 * - Permissions in this file are set on the context (not the project)
 *   because devices["Pixel 5"] overrides the project-level permissions
 *   array via context options.
 * - One project (chromium) is reused — we just swap the viewport / UA
 *   per spec. This keeps the test matrix flat.
 */
test.use({
  ...devices["Pixel 5"],
  permissions: ["microphone"]
});

test("deploy smoke (mobile) — sample show plays end-to-end on Pixel 5", async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.goto("/");

  await expect(page.locator("body")).toBeVisible();

  // The "Listen to a sample" CTA must be visible AND tappable at
  // mobile widths — a flex-shrink miss here would have it offscreen
  // or zero-sized.
  const sampleButton = page.getByRole("button", { name: /listen to a sample/i }).first();
  await expect(sampleButton).toBeVisible();
  const box = await sampleButton.boundingBox();
  expect(box, "sample CTA should have a render box on mobile").not.toBeNull();
  expect(box!.width, "sample CTA tap target width").toBeGreaterThanOrEqual(40);
  expect(box!.height, "sample CTA tap target height").toBeGreaterThanOrEqual(40);
  await sampleButton.click();

  await expect(page.getByRole("button", { name: /stop show/i }).first()).toBeVisible({
    timeout: 30_000
  });

  const captions = page.locator(".player-captions").first();
  await expect(captions).toBeVisible({ timeout: 30_000 });
  const firstWord = captions.locator(".live-transcript-word").first();
  await expect(firstWord).toBeVisible({ timeout: 30_000 });
  const captionText = (await firstWord.textContent())?.trim() ?? "";
  expect(captionText.length).toBeGreaterThan(0);

  // Audio actually playing — same Waveform.is-playing check as the
  // desktop smoke.
  await expect(page.locator(".waveform.is-playing")).not.toHaveCount(0, { timeout: 45_000 });

  // Player bar must remain on-screen at mobile width (this is the
  // common regression — the bar overflows the viewport on phones
  // because something inside it lost min-width:0). Check the
  // captions slot's right edge sits inside the viewport.
  const viewport = page.viewportSize();
  expect(viewport, "viewport size").not.toBeNull();
  const captionsBox = await captions.boundingBox();
  if (captionsBox) {
    expect(captionsBox.x, "captions slot must not start offscreen").toBeGreaterThanOrEqual(-1);
    expect(
      captionsBox.x + captionsBox.width,
      "captions slot right edge must stay within viewport"
    ).toBeLessThanOrEqual(viewport!.width + 1);
  }

  const fatal = consoleErrors.filter((e) => /Uncaught|TypeError|ReferenceError/.test(e));
  expect(fatal, `console fatals: ${fatal.join(" | ")}`).toHaveLength(0);
});
