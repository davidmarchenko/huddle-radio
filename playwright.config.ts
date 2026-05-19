import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for browser-level smoke tests.
 *
 * The vitest suites cover the data plane (route handlers, engine,
 * providers, parsers). Playwright covers what they can't reach:
 * page rendering, EventSource in a real browser, mic / display
 * permissions, audio playback wiring, the markets-flash animation.
 *
 * Each spec opens http://localhost:3000 and drives the UI like a
 * user would. The dev server (Next.js + Fastify) is auto-started
 * via webServer below — same `npm run dev` command developers use
 * locally — so `npm run test:browser` is one command end-to-end.
 *
 * Runs against Chromium only by default. Add Firefox / WebKit to
 * `projects` when we have multi-browser regressions to catch.
 */

// Allow pointing the suite at a remote deployment so a human-free
// verification loop can run against prod (or any preview URL). When
// PLAYWRIGHT_BASE_URL is set, we skip the auto-started local dev
// server — the browser tests just exercise the remote target.
//
// Example: `PLAYWRIGHT_BASE_URL=https://huddle-radio.vercel.app \
//   npx playwright test browser-tests/capture-transcript.spec.ts`
const REMOTE_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = REMOTE_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: /.*\.spec\.ts$/,
  // The dev server takes a few seconds to come up + each show needs
  // an opener + a tick or two; 60s per test gives slack without
  // hiding genuinely stuck tests.
  timeout: 60_000,
  expect: {
    // The opener commentary lands within ~5 seconds in mock mode;
    // give 20s of slack so a slow CI doesn't false-fail.
    timeout: 20_000
  },
  // Smoke specs are inherently sequential — one dev server, one
  // session-store, no parallelism. Workers=1 keeps SSE sessions
  // from racing each other on the in-process Map.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? "github" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure"
    // permissions are scoped to the chromium project — WebKit
    // doesn't recognize "microphone" as a permission name and errors
    // out when we try to grant it globally.
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Auto-grant mic permission so push-to-talk doesn't trigger
        // a permission popup that no test framework can dismiss.
        permissions: ["microphone"],
        // Fake mic/camera input so getUserMedia / getDisplayMedia
        // resolve without real hardware.
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
        }
      }
    },
    {
      // WebKit lane — engine parity with iOS Safari. Default project
      // runs are Chromium-only (the listener pool skews mobile-
      // Chromium). Run this lane on-demand to catch iOS-specific
      // regressions: AudioContext requires a real user gesture to
      // unlock, BroadcastChannel was a recent add, CSS @media calc
      // quirks. Run with `--project=webkit`.
      //
      // WebKit doesn't support the "microphone" permission grant by
      // name (Chrome-specific). Specs that need mic must skip on
      // WebKit explicitly. The major surfaces (listen, captions,
      // audio playback) work without mic — push-to-talk Cue host is
      // the only feature that needs it.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      // Skip specs that emulate Chromium-flavored mobile devices
      // (Pixel 5, narrow Android UA). Running them under WebKit is a
      // hybrid that doesn't represent any real device — mobile Safari
      // is exercised by prod-smoke + capture-transcript at desktop
      // viewport, which is enough to catch engine-specific bugs
      // (AudioContext gesture unlock, BroadcastChannel, CSS calc).
      testIgnore: ["**/prod-mobile.spec.ts", "**/narrow-mobile.spec.ts"]
    }
  ],
  // Only auto-start the dev server when targeting localhost.
  // Pointing at a remote URL skips this entirely.
  webServer: REMOTE_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        timeout: 60_000,
        reuseExistingServer: !process.env.CI
      }
});
