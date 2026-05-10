"use client";

import dynamic from "next/dynamic";

// The App is a heavily browser-dependent legacy client (localStorage,
// window.location, MediaRecorder, AudioContext). SSR provides zero
// value — render purely on the client. As we extract leaf components
// into proper Server Components, this dynamic import will shrink.
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

export default function HomePage() {
  return <HuddleApp />;
}
