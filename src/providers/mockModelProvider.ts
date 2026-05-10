import type { MultimodalModelProvider, ProviderHealth, VideoFrameSnapshot, VideoObservation, VideoSourceConfig, SportsPlay } from "../shared/contracts";

export class MockModelProvider implements MultimodalModelProvider {
  id = "mock-model";

  async observe(input: { video: VideoSourceConfig; play: SportsPlay; frame?: VideoFrameSnapshot }): Promise<VideoObservation> {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const sourceNote = sourceLabel(input.video);
    const summary = observationForPlay(input.play, sourceNote);
    return {
      id: crypto.randomUUID(),
      source: input.video.mode,
      summary,
      confidence: input.video.mode === "screen-share" ? 0.72 : 0.84,
      observedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
      usedFrame: Boolean(input.frame),
      validation: {
        status: input.frame ? "uncertain" : "unavailable",
        confidence: input.frame ? 0.5 : 0,
        sport: "football",
        evidence: input.frame ? ["Mock mode received a captured frame but did not inspect pixels."] : ["No captured frame reached the model provider."],
        reason: input.frame ? "Mock model cannot truly validate the stream." : "Frame capture unavailable, blocked, or not sent.",
        validatedAt: new Date().toISOString(),
        frameAgeMs: input.frame ? Date.now() - Date.parse(input.frame.capturedAt) : undefined
      }
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      label: "Mock Multimodal Model",
      status: "ready",
      detail: "Simulating Nemotron-style video/audio observations locally."
    };
  }
}

function sourceLabel(video: VideoSourceConfig) {
  if (video.mode === "screen-share") return "from the shared screen";
  if (video.mode === "vod") return "from the replay";
  return video.url ? "from the user stream" : "from the demo event feed";
}

function observationForPlay(play: SportsPlay, sourceNote: string) {
  const variants: Record<SportsPlay["type"], string[]> = {
    pass: [
      `The read ${sourceNote} suggests the coverage bent late, which fits the timing of that completion.`,
      `The pocket movement and receiver break line up with a quick fantasy-relevant passing gain.`,
      `The model read is seeing separation after the snap rather than a busted coverage.`
    ],
    rush: [
      `The run shape ${sourceNote} looks like patience first, burst second.`,
      `Blocking leverage is the story here: the runner had a clear crease before contact.`,
      `This looked less like a broken play and more like a designed lane finally opening.`
    ],
    touchdown: [
      `The scoring sequence ${sourceNote} had red-zone urgency all over it.`,
      `The finish matched the box score: decisive route or lane, then immediate scoreboard pain for someone.`,
      `The model read catches a clean payoff moment, not just empty yardage.`
    ],
    "first-down": [
      `The marker context matters here; that looked like a chain-moving play more than a highlight grab.`,
      `The sideline and down-distance cues point to a drive extender.`,
      `The important part is the possession staying alive, even if the fantasy swing is modest.`
    ],
    turnover: [
      `The body language after the throw says danger immediately; this is a possession swing, not just a stat correction.`,
      `The pressure cue shows up before the mistake, which makes the turnover feel earned by the defense.`,
      `This is the kind of visual sequence where the group chat goes quiet for one manager very quickly.`
    ],
    "field-goal": [
      `The operation looked clean enough; useful scoreboard context, light fantasy heat.`,
      `This is more game-state seasoning than group-chat detonation.`,
      `The kick changes the scoreboard, but the fantasy blast radius is small.`
    ],
    other: [
      `The model read adds context, but the official play feed is still the source of truth.`,
      `The visual cue is useful background rather than the main event.`,
      `There is enough context to call the moment without overclaiming.`
    ]
  };
  const options = variants[play.type] ?? variants.other;
  return options[stableIndex(play.id, options.length)];
}

function stableIndex(value: string, modulo: number) {
  return [...value].reduce((total, char) => total + char.charCodeAt(0), 0) % modulo;
}
