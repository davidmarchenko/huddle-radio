import type { NextConfig } from "next";

// Fastify still owns /api/* and the WebSocket during the migration —
// the rewrites below transparently forward unmigrated paths to it on
// :8787. As each Fastify route gets ported to a Next.js Route Handler
// under src/app/api/, drop its rewrite entry. When the list is empty,
// Fastify can be removed.
const FASTIFY_TARGET = process.env.FASTIFY_INTERNAL_URL ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-fetch"],
  experimental: {
    // Frame uploads from screen-share can exceed the 1 MB default.
    serverActions: {
      bodySizeLimit: "8mb"
    }
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${FASTIFY_TARGET}/api/:path*` },
      { source: "/ws/:path*", destination: `${FASTIFY_TARGET}/ws/:path*` }
    ];
  }
};

export default nextConfig;
