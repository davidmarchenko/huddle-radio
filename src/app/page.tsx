import { App, AppErrorBoundary } from "@/client/main";

export default function HomePage() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}
