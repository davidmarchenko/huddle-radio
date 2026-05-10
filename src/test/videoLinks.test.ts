import { describe, expect, it } from "vitest";
import { createYouTubeEmbedUrl, extractYouTubeVideoId, isYouTubeUrl } from "../shared/videoLinks";

describe("YouTube video link helpers", () => {
  it("extracts ids from common YouTube URL shapes", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("builds an embed URL for playable iframe previews", () => {
    expect(createYouTubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1");
  });

  it("does not treat unrelated links as YouTube URLs", () => {
    expect(isYouTubeUrl("https://example.com/video.mp4")).toBe(false);
    expect(createYouTubeEmbedUrl("not a url")).toBeUndefined();
  });
});
