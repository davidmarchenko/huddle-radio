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
    env: { NODE_ENV: "test" }
  },
  resolve: {
    // Mirror the @/* path alias from tsconfig.json so route-handler
    // tests can import the same files Next.js resolves at build time.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
