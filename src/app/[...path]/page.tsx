"use client";

import dynamic from "next/dynamic";

/**
 * Catch-all route for client-side deep links. The HuddleApp uses
 * `window.history.pushState` to surface the active show as `/watch/{gameId}`,
 * so reloads, shares, and back/forward navigation hit the server with that
 * URL. Without this route, Next.js 404s (no `app/watch/[id]/page.tsx`).
 *
 * Renders the same client bundle as `/`. The client reads
 * `window.location.pathname` on mount and restores the right view.
 *
 * `app/page.tsx` (root "/") still wins for the empty path; this catch-all
 * only matches non-empty segments. Static API routes + file-convention
 * paths (`/api/*`, `/icon.svg`, `/_next/*`) win over `[...path]` because
 * they're more specific.
 */

const HuddleApp = dynamic(
  () => import("@/client/main").then((mod) => ({
    default: function HuddleAppRoot() {
      const App = mod.App;
      const Boundary = mod.AppErrorBoundary;
      return (
        <Boundary>
          <App />
        </Boundary>
      );
    }
  })),
  { ssr: false }
);

export default function CatchAllPage() {
  return <HuddleApp />;
}
