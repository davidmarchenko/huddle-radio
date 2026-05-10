import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../server/app";
import type { ClientServerEvent } from "../shared/contracts";

describe("livecast websocket", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("streams snapshot, play, commentary, and mock TTS events", async () => {
    const app = await buildApp();
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address.");

    const events = await collectLivecastEvents(`ws://127.0.0.1:${address.port}/ws/livecast`, {
      cadenceMs: 3000,
      ttsEnabled: true
    });

    expect(events.some((event) => event.type === "snapshot")).toBe(true);
    expect(events.some((event) => event.type === "play")).toBe(true);
    expect(events.some((event) => event.type === "commentary")).toBe(true);
    expect(events.some((event) => event.type === "tts")).toBe(true);
    // Show opener fires first and addresses the listener by name.
    const opener = events.find((event) => event.type === "commentary" && event.commentary.kind === "opener");
    expect(opener?.type === "commentary" ? opener.commentary.text : "").toMatch(/Alex/);
    expect(opener?.type === "commentary" ? opener.commentary.hostId : "").toBe("theo");
    // Per-play commentary still references the live game clock.
    const playCommentary = events.find((event) => event.type === "commentary" && event.commentary.kind === "play");
    expect(playCommentary?.type === "commentary" ? playCommentary.commentary.text : "").toContain("Q2");
  });

  it("honors a listener nudge — the next play commentary is delivered by the cued host", async () => {
    const app = await buildApp();
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address.");

    // Cue Cam mid-stream after the first play turn arrives, then wait
    // for a subsequent play turn and verify it's Cam delivering it.
    const result = await new Promise<{ firstPlay: ClientServerEvent; nudgedPlay: ClientServerEvent }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/livecast`);
      let firstPlay: ClientServerEvent | undefined;
      let nudgeSent = false;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for nudged commentary."));
      }, 12_000);

      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "start", request: { cadenceMs: 3000, ttsEnabled: false } }));
      });

      socket.on("message", (data) => {
        const event = JSON.parse(String(data)) as ClientServerEvent;
        if (event.type !== "commentary") return;
        if (event.commentary.kind !== "play") return;
        if (!firstPlay) {
          firstPlay = event;
          // Nudge a host that's NOT the deterministic pick. selectHost
          // for demoPlays[0] (a non-touchdown pass) routes to "theo" by
          // default. Asking for "cam" forces the override path.
          socket.send(JSON.stringify({ type: "nudge", hostId: "cam" }));
          nudgeSent = true;
          return;
        }
        if (nudgeSent) {
          clearTimeout(timer);
          socket.close();
          resolve({ firstPlay, nudgedPlay: event });
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const firstHost = result.firstPlay.type === "commentary" ? result.firstPlay.commentary.hostId : "";
    const nudgedHost = result.nudgedPlay.type === "commentary" ? result.nudgedPlay.commentary.hostId : "";
    expect(nudgedHost).toBe("cam");
    // Assert the override actually changed something — i.e. the nudge
    // wasn't a no-op because Cam was already next.
    expect(firstHost).not.toBe("cam");
  }, 15_000);
});

function collectLivecastEvents(url: string, request: object): Promise<ClientServerEvent[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const events: ClientServerEvent[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for livecast events."));
    }, 5000);

    socket.on("open", () => {
      socket.send(JSON.stringify(request));
    });

    socket.on("message", (data) => {
      const event = JSON.parse(String(data)) as ClientServerEvent;
      events.push(event);
      const hasOpener = events.some((item) => item.type === "commentary" && item.commentary.kind === "opener");
      const hasPlayCommentary = events.some((item) => item.type === "commentary" && item.commentary.kind === "play");
      if (events.some((item) => item.type === "snapshot") && events.some((item) => item.type === "play") && hasOpener && hasPlayCommentary && events.some((item) => item.type === "tts")) {
        clearTimeout(timer);
        socket.close();
        resolve(events);
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
