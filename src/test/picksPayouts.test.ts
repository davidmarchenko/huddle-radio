import { describe, expect, it } from "vitest";
import { payoutMultiplierFor, projectedPayout, settlePayout } from "../shared/picksPayouts";
import type { PickStatus } from "../shared/picksContracts";

function pick(status: PickStatus["status"]): PickStatus {
  return { propId: "p", side: "more", line: 10, progress: 1, status };
}

describe("payoutMultiplierFor", () => {
  it("matches the PrizePicks public table", () => {
    expect(payoutMultiplierFor(2)).toBe(3);
    expect(payoutMultiplierFor(3)).toBe(5);
    expect(payoutMultiplierFor(4)).toBe(10);
    expect(payoutMultiplierFor(5)).toBe(20);
    expect(payoutMultiplierFor(6)).toBe(37.5);
  });

  it("returns 0 outside the 2-6 leg range", () => {
    expect(payoutMultiplierFor(1)).toBe(0);
    expect(payoutMultiplierFor(7)).toBe(0);
  });
});

describe("settlePayout", () => {
  it("pays only when every leg is a hit", () => {
    expect(settlePayout([pick("hit"), pick("hit")])).toBe(30);
    expect(settlePayout([pick("hit"), pick("miss")])).toBe(0);
    expect(settlePayout([pick("hit"), pick("push")])).toBe(0);
  });

  it("returns 0 with fewer than 2 picks", () => {
    expect(settlePayout([pick("hit")])).toBe(0);
  });
});

describe("projectedPayout", () => {
  it("treats live-on-track as a provisional hit", () => {
    expect(projectedPayout([pick("hit"), pick("live-on-track")])).toBe(30);
  });

  it("returns 0 when any pick is off-track or pending", () => {
    expect(projectedPayout([pick("hit"), pick("live-off-track")])).toBe(0);
    expect(projectedPayout([pick("hit"), pick("pending")])).toBe(0);
  });
});
