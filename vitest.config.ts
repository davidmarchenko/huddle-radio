import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/test/providerSmoke.test.ts", "node_modules/**", ".git/**"]
  },
  resolve: {
    // Mirror the @/* path alias from tsconfig.json so route-handler
    // tests can import the same files Next.js resolves at build time.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
