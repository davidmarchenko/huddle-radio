import { describe, expect, it } from "vitest";
import { buildDiagnostics } from "../server/app";

describe("buildDiagnostics", () => {
  it("returns the expected envelope shape", async () => {
    const diagnostics = await buildDiagnostics("demo");
    expect(diagnostics.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Array.isArray(diagnostics.health)).toBe(true);
    expect(Array.isArray(diagnostics.checks)).toBe(true);
    expect(diagnostics.providers).toEqual(
      expect.objectContaining({
        fantasy: expect.any(String),
        sportsData: expect.any(String),
        news: expect.any(String),
        commentary: expect.any(String),
        tts: expect.any(String)
      })
    );
  });

  it("toggles `sportsData` summary based on the requested mode", async () => {
    const demo = await buildDiagnostics("demo");
    const espn = await buildDiagnostics("espn");
    expect(demo.providers.sportsData).toMatch(/Demo/i);
    expect(espn.providers.sportsData).toMatch(/ESPN/i);
  });

  it("returns at least one health entry per provider class", async () => {
    const diagnostics = await buildDiagnostics("demo");
    const labels = diagnostics.health.map((entry) => entry.label.toLowerCase());
    // Loose check — we expect demo fantasy, demo sports data, news,
    // commentary, tts at minimum to surface in the union of providers.
    expect(labels.some((label) => label.includes("fantasy"))).toBe(true);
    expect(labels.some((label) => label.includes("sport"))).toBe(true);
    expect(labels.some((label) => label.includes("commentary"))).toBe(true);
  });

  it("checks include OpenAI commentary and ElevenLabs TTS rows", async () => {
    const diagnostics = await buildDiagnostics("demo");
    const ids = diagnostics.checks.map((check) => check.id);
    expect(ids).toContain("openai-commentary");
    expect(ids).toContain("elevenlabs-tts");
  });
});
