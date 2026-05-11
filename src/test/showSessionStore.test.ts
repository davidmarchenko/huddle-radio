import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  destroySession,
  getSessionWithRoutingHint,
  lookupErrorResponse,
  registerSession,
  resetSessionStoreForTests
} from "../server/showSessionStore";
import {
  MemoryRegistry,
  resetDefaultSessionRegistryForTests,
  getInstanceId
} from "../server/sessionRegistry";
import { ShowEngine } from "../server/showEngine";

/**
 * Tests the cross-instance routing hint. The session store wraps an
 * in-process Map plus the SessionRegistry; routes use the wrapper to
 * tell whether a missing local session is genuinely unknown (404) or
 * lives on a different Function instance (410).
 */

function makeStubEngine(): ShowEngine {
  // The store doesn't read engine state during routing — it just calls
  // .stop() at teardown. Cast a tiny stub through unknown to satisfy
  // the type without dragging in the real engine + providers.
  const stop = vi.fn();
  const stub = { id: `engine-${Math.random().toString(36).slice(2)}`, stop } as unknown as ShowEngine;
  return stub;
}

describe("getSessionWithRoutingHint", () => {
  beforeEach(() => {
    resetDefaultSessionRegistryForTests(new MemoryRegistry());
    resetSessionStoreForTests();
  });

  afterEach(() => {
    resetSessionStoreForTests();
    resetDefaultSessionRegistryForTests(undefined);
  });

  it("returns kind:'local' when the session lives in this process", async () => {
    const engine = makeStubEngine();
    const id = await registerSession(engine);
    const lookup = await getSessionWithRoutingHint(id);
    expect(lookup.kind).toBe("local");
    if (lookup.kind === "local") {
      expect(lookup.engine).toBe(engine);
    }
  });

  it("returns kind:'missing' when no instance owns the session", async () => {
    const lookup = await getSessionWithRoutingHint("never-existed");
    expect(lookup.kind).toBe("missing");
  });

  it("returns kind:'remote' when another instance owns the session", async () => {
    // Simulate the cross-instance case: register the session ID against
    // a different instance id directly in the registry without touching
    // the local SESSIONS map.
    const registry = new MemoryRegistry();
    resetDefaultSessionRegistryForTests(registry);
    await registry.register("foreign-session", "other-instance-id", 60);
    const lookup = await getSessionWithRoutingHint("foreign-session");
    expect(lookup.kind).toBe("remote");
    if (lookup.kind === "remote") {
      expect(lookup.instanceId).toBe("other-instance-id");
    }
  });

  it("returns kind:'missing' when the registry says we own it but the local Map evicted it (engine reaped)", async () => {
    const registry = new MemoryRegistry();
    resetDefaultSessionRegistryForTests(registry);
    // Pretend a previous request on this same instance registered the
    // session, but the engine got reaped (DETACH_GRACE_MS) before the
    // follow-up POST. The registry record still exists with our own
    // instanceId. Treat as missing — there's nothing to route to.
    await registry.register("orphaned", getInstanceId(), 60);
    const lookup = await getSessionWithRoutingHint("orphaned");
    expect(lookup.kind).toBe("missing");
  });

  it("destroySession removes both the local engine and the registry record", async () => {
    const engine = makeStubEngine();
    const id = await registerSession(engine);
    expect((await getSessionWithRoutingHint(id)).kind).toBe("local");
    destroySession(id);
    // The teardown runs registry.unregister inside a void-catch — give
    // it a microtask to settle before re-querying.
    await Promise.resolve();
    expect((await getSessionWithRoutingHint(id)).kind).toBe("missing");
  });
});

describe("lookupErrorResponse", () => {
  it("returns undefined for kind:'local' so the route proceeds", () => {
    const engine = makeStubEngine();
    const result = lookupErrorResponse(
      { kind: "local", engine },
      { route: "test", sessionId: "sid" }
    );
    expect(result).toBeUndefined();
  });

  it("returns 410 with WRONG_INSTANCE for kind:'remote'", async () => {
    const result = lookupErrorResponse(
      { kind: "remote", instanceId: "other" },
      { route: "test", sessionId: "sid" }
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(410);
    const body = await result!.json();
    expect(body.code).toBe("WRONG_INSTANCE");
  });

  it("returns 404 with NOT_FOUND for kind:'missing'", async () => {
    const result = lookupErrorResponse(
      { kind: "missing" },
      { route: "test", sessionId: "sid" }
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(404);
    const body = await result!.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});
