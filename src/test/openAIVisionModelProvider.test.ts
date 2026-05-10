import { describe, expect, it } from "vitest";
import { parseVisionPayload } from "../providers/openAIVisionModelProvider";

describe("parseVisionPayload", () => {
  it("parses compact sports validation JSON", () => {
    const payload = parseVisionPayload(
      JSON.stringify({
        isSportsEvent: true,
        sport: "football",
        confidence: 0.91,
        summary: "A football broadcast frame with players lined up.",
        evidence: ["football field", "players in formation", "score bug"],
        reason: "Visible broadcast elements indicate a football game."
      })
    );

    expect(payload.isSportsEvent).toBe(true);
    expect(payload.sport).toBe("football");
    expect(payload.confidence).toBe(0.91);
    expect(payload.evidence).toHaveLength(3);
  });

  it("falls back safely for non-JSON text", () => {
    const payload = parseVisionPayload("Looks like a scoreboard, but I am not sure.");
    expect(payload.confidence).toBe(0.25);
    expect(payload.reason).toContain("non-JSON");
  });
});
