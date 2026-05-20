import { expect, test } from "@playwright/test";

/**
 * Snapshots the dialogue actually spoken during a sample show and
 * asserts that none of the producer-jargon strings the local
 * fallback used to leak (`Visual validation is uncertain`,
 * `fantasy blast radius`, `Fantasy impact gets priority over the
 * scoreboard`, `Model read is tentative`, score-bug period
 * prefixes like "OT, 0.0:") appear in the spoken text. This pins
 * the listener-facing contract independently of whether the LLM
 * succeeded or fell through to the local template.
 *
 * Runs longer than a smoke spec because we need enough TICKS for
 * the assertion to be meaningful: the opener alone won't exercise
 * the per-tick `buildCommentaryText` paths; we need at least one
 * play turn through the engine. ~45s of captured captions covers
 * the opener + 1-2 ticks at the default cadence.
 */
test("dialogue never emits producer jargon to the listener", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("button", { name: /listen to a sample/i }).first().click();
  await expect(page.getByRole("button", { name: /stop show/i }).first()).toBeVisible({
    timeout: 30_000
  });
  // Wait for the captions to start, then dwell long enough for at
  // least one tick after the opener.
  await expect(page.locator(".player-captions .live-transcript-word").first()).toBeVisible({
    timeout: 45_000
  });
  await page.waitForTimeout(45_000);

  // Snapshot every word ever rendered in the live transcript area
  // OR in the player bar captions. The two surfaces share the
  // `.live-transcript-word` class so a single selector covers both
  // — the player bar shows the active line, the panel (when
  // mounted) shows the running transcript.
  const wordTexts = await page.locator(".live-transcript-word").allTextContents();
  const joined = wordTexts.join(" ").replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-console
  console.log("\n===== CAPTURED DIALOGUE =====\n" + joined.slice(0, 2000));
  expect(joined.length, "expected at least one rendered transcript line").toBeGreaterThan(0);

  // Banned phrases — producer scaffolding that used to leak into
  // the spoken text. Each pattern names the historical bug.
  const bannedPatterns: Array<{ name: string; pattern: RegExp }> = [
    { name: "validation telemetry", pattern: /Visual validation/i },
    { name: "tentative model read", pattern: /Model read is tentative/i },
    { name: "blast-radius metaphor", pattern: /fantasy blast radius/i },
    { name: "framing-rule disclosure", pattern: /Fantasy impact gets priority/i },
    { name: "framing-rule disclosure 2", pattern: /priority over the scoreboard/i },
    { name: "score-bug period prefix (OT)", pattern: /OT,\s*\d/ },
    { name: "score-bug period prefix (Qn)", pattern: /\bQ\d,\s\d/ },
    { name: "score-bug period prefix (Pn)", pattern: /\bP\d,\s\d/ },
    { name: "official-feed disclaimer", pattern: /official play feed/i },
    { name: "interrupt-worthy stage direction", pattern: /Interrupt-worthy:/i },
    { name: "context-note prefix", pattern: /Context note:/i }
  ];
  for (const { name, pattern } of bannedPatterns) {
    expect(joined, `dialogue contained "${name}" (${pattern})`).not.toMatch(pattern);
  }
});
