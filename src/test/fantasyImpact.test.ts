import { describe, expect, it } from "vitest";
import { rankFantasyImpacts } from "../engine/fantasyImpact";
import { demoLeagueState, demoPlays } from "../providers/demoData";

describe("rankFantasyImpacts", () => {
  it("ranks impacted rostered players by estimated points swing", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[1]);
    expect(impacts[0]).toMatchObject({
      ownerName: "Maya",
      playerName: "Travis Kelce",
      isStarter: true,
      pointsDelta: 6.5
    });
    expect(impacts.some((impact) => impact.playerName === "Patrick Mahomes")).toBe(true);
  });

  it("scores quarterback turnovers as negative fantasy impact", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[4]);
    expect(impacts[0]).toMatchObject({
      ownerName: "Alex",
      playerName: "Patrick Mahomes",
      pointsDelta: -2
    });
  });

  it("does not emit impact rows for unrostered field goals", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[7]);
    expect(impacts).toEqual([]);
  });

  it("applies reception bonus for skill-position catches", () => {
    const impacts = rankFantasyImpacts(demoLeagueState, demoPlays[9]);
    expect(impacts[0]).toMatchObject({
      playerName: "Amon-Ra St. Brown",
      pointsDelta: 6.5
    });
  });
});
