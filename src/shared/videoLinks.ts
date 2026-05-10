export function createYouTubeEmbedUrl(rawUrl: string) {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (!videoId) return undefined;
  return `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1`;
}

export function extractYouTubeVideoId(rawUrl: string) {
  if (!rawUrl.trim()) return undefined;

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return normalizeVideoId(url.pathname.split("/").filter(Boolean)[0]);
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") {
        return normalizeVideoId(url.searchParams.get("v") ?? "");
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "live", "shorts"].includes(parts[0])) {
        return normalizeVideoId(parts[1]);
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function isYouTubeUrl(rawUrl: string) {
  return Boolean(extractYouTubeVideoId(rawUrl));
}

function normalizeVideoId(value = "") {
  const match = value.match(/^[A-Za-z0-9_-]{6,}$/);
  return match ? value : undefined;
}
