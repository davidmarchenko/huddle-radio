import { expect, test } from "@playwright/test";

/**
 * Browser-level smoke for the video-stage live UI.
 *
 * The audio-only path is covered in golden-path.spec.ts. This spec
 * proves the *video* path mounts: phase transitions from live-audio
 * to live, the .video-stage layout renders, and the overlay
 * components (ScoreBug, MarketsTicker, FantasyMatchupFloat) compose
 * over the video element.
 *
 * Strategy: start the demo show in audio mode, then drop a YouTube
 * URL into the Setup → Stream input. `deriveHuddlePhase` flips to
 * "live" the moment hasVideoSource becomes true, and the React tree
 * remounts as HuddleLiveWithStream with the iframe + overlays.
 *
 * We use a known-good YouTube URL so the iframe receives a real src
 * (no test-fixture YouTube account needed); we never wait for the
 * video to actually play, only for the layout to render.
 */

const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function startSampleAndOpenStreamSetup(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  // Wait until the audio-live phase has rendered before driving setup
  // — the Stream button on the player bar isn't reliably present
  // until the show is mounted.
  await expect(page.getByRole("button", { name: /stop show/i }).first()).toBeVisible({ timeout: 30_000 });
  // The audio-live player bar exposes an "Add stream" button that
  // opens the producer drawer with the Stream pane already selected,
  // so the listener can swap from audio-only to a video source mid-
  // show without ending the cast. The button used to be named just
  // "Stream"; the regex covers both forms.
  await page.getByRole("button", { name: /add stream|^stream$/i }).first().click();
}

test("typing a video URL flips the live UI from audio-only to the video stage", async ({ page }) => {
  await startSampleAndOpenStreamSetup(page);

  // Stream pane's URL field. Visible-label match — the input is
  // wrapped in a <label>Stream or VOD URL<input/></label>.
  const urlInput = page.getByLabel(/stream or vod url/i);
  await expect(urlInput).toBeVisible({ timeout: 10_000 });
  await urlInput.fill(YOUTUBE_URL);
  // Lose focus so React commits the input change before we assert
  // on phase-derived UI.
  await urlInput.blur();

  // Phase should flip live-audio → live. The wrapping <main> carries
  // a `phase-<phase>` class so we assert directly on it.
  await expect(page.locator("main.huddle-app.phase-live")).toBeVisible({ timeout: 10_000 });

  // The video-stage layout is the visual proof: section.live-layout
  // wraps a div.video-stage that hosts the iframe + overlays.
  await expect(page.locator("section.live-layout div.video-stage")).toBeVisible();

  // The MarketsTicker overlay is a unique video-stage child —
  // confirms the overlay tree composed correctly over the video.
  await expect(page.locator("div.video-stage .markets-ticker")).toBeVisible();
});

test("YouTube URLs render the iframe preview in the video stage", async ({ page }) => {
  await startSampleAndOpenStreamSetup(page);
  const urlInput = page.getByLabel(/stream or vod url/i);
  await urlInput.fill(YOUTUBE_URL);
  await urlInput.blur();

  // YouTube URLs route through createYouTubeEmbedUrl → an <iframe>
  // (rather than the <video> element used for direct media URLs).
  // We assert the iframe mounts with a youtube-nocookie embed src
  // so an empty `src` (a regression where the embed util breaks)
  // would fail the test.
  const iframe = page.locator("section.live-layout div.video-stage iframe");
  await expect(iframe).toBeVisible({ timeout: 10_000 });
  const src = await iframe.getAttribute("src");
  expect(src ?? "").toMatch(/youtube(-nocookie)?\.com\/embed\//);
});
