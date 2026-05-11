/**
 * Best-effort secret redaction for server-emitted error messages.
 * Catches the most common shapes of API keys and SWID:S2 cookies so
 * a stack trace bubbling out of a vendor SDK doesn't leak credentials
 * to the WS / SSE client.
 *
 * Lives in its own module so both app.ts (Fastify) and showEngine.ts
 * (transport-agnostic) can import without a circular dependency.
 */
export function redactSecret(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[A-Fa-f0-9]{24,}:[A-Fa-f0-9]{24,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
