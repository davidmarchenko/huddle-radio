import type { NextConfig } from "next";

// In local dev, Fastify owns the routes that haven't been ported to
// Next.js Route Handlers yet — /ws/livecast (legacy WS show), plus a
// handful of diagnostics endpoints (/api/health, /api/diagnostics,
// /api/model-stack, /api/history/shows). The rewrites below
// transparently forward those to Fastify on :8787 so the dev story
// keeps working while the migration is in flight.
//
// We disable the rewrite in any production build (Vercel *or* local
// `next start`). Vercel has no Fastify process; local prod-mode smoke
// also runs without Fastify when verifying the deployable bundle.
// Without this guard, both setups 500 with ECONNREFUSED on every
// unported route. With it, unported routes 404 cleanly and the UI
// degrades gracefully (the diagnostics surfaces tolerate 404s; the
// WS path is dead code outside dev since the client uses SSE).
const FASTIFY_TARGET = process.env.FASTIFY_INTERNAL_URL ?? "http://localhost:8787";
const REWRITE_TO_FASTIFY = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-fetch"],
  experimental: {
    // Frame uploads from screen-share can exceed the 1 MB default.
    serverActions: {
      bodySizeLimit: "8mb"
    }
  },
  async rewrites() {
    if (!REWRITE_TO_FASTIFY) return [];
    return [
      // /api/:path* runs Next.js Route Handlers FIRST (when one
      // exists at that path), then falls through to this rewrite if
      // no handler matched. So /api/clips, /api/live/*, /api/markets,
      // /api/vision/*, /api/asr/*, /api/clip/* go to Next; only the
      // unported routes hit Fastify.
      { source: "/api/:path*", destination: `${FASTIFY_TARGET}/api/:path*` },
      { source: "/ws/:path*", destination: `${FASTIFY_TARGET}/ws/:path*` }
    ];
  }
};

export default nextConfig;
