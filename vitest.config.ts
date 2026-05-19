import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/test/providerSmoke.test.ts", "node_modules/**", ".git/**"],
    // Force NODE_ENV=test in worker processes so `config.ts`'s
    // `isTest` gate fires and the engine resolves to local/mock
    // providers instead of inheriting the shell's OPENAI_API_KEY +
    // hitting the real API. Without this, every test run flaked when
    // the dev's shell had a real key set (api.live.test.ts,
    // websocketLivecast.test.ts, etc. timed out racing OpenAI
    // latency variance).
    env: { NODE_ENV: "test" },
    // Default vitest testTimeout is 5s, which is fine for unit tests
    // but routinely truncates the integration-style specs in this
    // suite: anything that calls `buildApp()` (Fastify boot + plugin
    // graph), spins up a `ShowEngine` with timers, opens an SSE
    // stream, or waits on a websocket handshake. Under any CPU
    // contention (dev server in another process, parallel test
    // workers fighting for cores) those routinely cross 5s and the
    // suite reports false failures that hide real regressions.
    // 20s is enough headroom that genuinely-broken tests still
    // surface quickly without the suite flaking when the laptop is
    // busy. Individual tests already declare longer overrides where
    // they need them (e.g. showEngine slate tests).
    testTimeout: 20_000,
    // Same reasoning for hooks (beforeAll spinning up Fastify, etc.)
    // — a slow boot shouldn't fail an otherwise-correct test.
    hookTimeout: 20_000,
    // The integration specs (api.live, websocketLivecast, showEngine)
    // each spin up real Fastify apps and ShowEngine instances with
    // real setInterval-driven ticks. Their assertions depend on those
    // tick events landing within a real wall-clock window. With the
    // default fork-per-CPU parallelism, engine timers in file A
    // starve when file B is also running heavy work in another worker
    // — the ticks fall behind, the consumer's deadline elapses, and
    // we see "expected snapshot; got undefined".
    // fileParallelism=false runs all test files sequentially in one
    // worker. Total wall-clock goes from ~30s flaky → ~50s rock-
    // solid. Worth the trade for reliable CI signal.
    fileParallelism: false,
    // Within a file, tests run sequentially by default (no
    // describe.concurrent) — leaving this explicit so a future flip
    // doesn't bring back the flakes.
    sequence: { concurrent: false }
  },
  resolve: {
    // Mirror the @/* path alias from tsconfig.json so route-handler
    // tests can import the same files Next.js resolves at build time.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
