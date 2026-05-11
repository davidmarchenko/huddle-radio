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
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // Auto-grant any permission the app asks for (mic, camera) so
    // we can exercise the push-to-talk flow without a browser
    // popup.
    permissions: ["microphone"]
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Fake mic/camera input so getUserMedia / getDisplayMedia
        // resolve without real hardware.
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
        }
      }
    }
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI
  }
});
