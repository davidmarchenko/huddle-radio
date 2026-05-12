import { NextResponse } from "next/server";

/**
 * OpenGraph metadata fetcher for iMessage-style link previews.
 *
 * Takes a `?url=` query, fetches the page server-side (avoids browser
 * CORS), parses og:* / twitter:* / standard meta tags via lightweight
 * regex (no jsdom dep — these tag patterns are stable enough that a
 * proper HTML parser is overkill), and returns a normalized payload.
 *
 * Cached in-memory with a 1-hour TTL so repeated hovers across a
 * session don't refetch the same article. The cache is per-process —
 * fine for a single Vercel function or local dev; for multi-instance
 * deploys this would graduate to Upstash Redis.
 */

export const runtime = "nodejs";
export const maxDuration = 10;

type OgPreview = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** Hostname for the "domain · 5m ago" footer style. */
  domain?: string;
  /** Best-effort favicon for chrome on the card footer. */
  favicon?: string;
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { value: OgPreview; expiresAt: number }>();

const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 256_000; // first ~256KB is plenty for <head> meta tags.
const USER_AGENT =
  "Mozilla/5.0 (compatible; HuddleRadioBot/1.0; +https://huddleradio.app)";

export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter." }, { status: 400 });
  }

  // Validate the target URL — only http(s), no file://, javascript:, etc.
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Only http(s) urls supported.");
    }
  } catch {
    return NextResponse.json({ error: "Invalid url parameter." }, { status: 400 });
  }

  const cacheKey = target.toString();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(JSON.stringify({ event: "preview.og.cache_hit", url: cacheKey }));
    return jsonWithCache(cached.value);
  }

  const startedAt = Date.now();
  try {
    const html = await fetchHtmlExcerpt(target.toString());
    const preview = parseOgFromHtml(html, target);
    cache.set(cacheKey, { value: preview, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(
      JSON.stringify({
        event: "preview.og.ok",
        url: cacheKey,
        latencyMs: Date.now() - startedAt,
        hasImage: Boolean(preview.image),
        hasTitle: Boolean(preview.title)
      })
    );
    return jsonWithCache(preview);
  } catch (error) {
    // Graceful degraded preview — at least the domain so the card
    // doesn't render blank.
    const fallback: OgPreview = {
      url: target.toString(),
      domain: target.hostname.replace(/^www\./, ""),
      favicon: `https://${target.hostname}/favicon.ico`
    };
    console.warn(
      JSON.stringify({
        event: "preview.og.failed",
        url: cacheKey,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return jsonWithCache(fallback);
  }
}

function jsonWithCache(preview: OgPreview) {
  return NextResponse.json(
    { preview },
    {
      headers: {
        // CDN cache as well so multiple users don't each refetch the
        // same article.
        "Cache-Control": "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400"
      }
    }
  );
}

async function fetchHtmlExcerpt(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        // Some sites gatekeep meta tags behind a real-browser UA.
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml"
      },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    // Read only the first chunk we care about. <head> meta tags are
    // always at the top, so capping prevents huge SPA bundles from
    // pulling megabytes for no reason.
    const reader = response.body?.getReader();
    if (!reader) return await response.text();
    const decoder = new TextDecoder("utf-8");
    let html = "";
    let received = 0;
    while (received < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      // Bail as soon as we've passed </head> — meta tags are done.
      if (html.includes("</head>")) break;
    }
    try {
      reader.cancel();
    } catch {
      // Ignore cancel errors — we got what we needed.
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

export function parseOgFromHtml(html: string, target: URL): OgPreview {
  const head = html.split("</head>")[0] ?? html;
  const ogImage = matchMeta(head, "og:image") ?? matchMeta(head, "twitter:image");
  const ogTitle =
    matchMeta(head, "og:title") ?? matchMeta(head, "twitter:title") ?? matchTitle(head);
  const ogDesc = matchMeta(head, "og:description") ?? matchMeta(head, "twitter:description") ?? matchMetaName(head, "description");
  const siteName = matchMeta(head, "og:site_name");
  const domain = target.hostname.replace(/^www\./, "");
  const favicon = matchFavicon(head, target) ?? `https://${target.hostname}/favicon.ico`;
  return {
    url: target.toString(),
    title: cleanText(ogTitle),
    description: cleanText(ogDesc),
    image: absolutize(ogImage, target),
    siteName: cleanText(siteName),
    domain,
    favicon: absolutize(favicon, target)
  };
}

function matchMeta(head: string, prop: string): string | undefined {
  // Both attribute orders: <meta property="og:image" content="..."> and
  // <meta content="..." property="og:image"> show up in the wild.
  const re1 = new RegExp(
    `<meta[^>]*property=["']${escapeRe(prop)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${escapeRe(prop)}["'][^>]*>`,
    "i"
  );
  return head.match(re1)?.[1] ?? head.match(re2)?.[1];
}

function matchMetaName(head: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]*name=["']${escapeRe(name)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return head.match(re)?.[1];
}

function matchTitle(head: string): string | undefined {
  return head.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
}

function matchFavicon(head: string, target: URL): string | undefined {
  const re = /<link[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i;
  const href = head.match(re)?.[1];
  if (!href) return undefined;
  return absolutize(href, target);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(s?: string): string | undefined {
  if (!s) return undefined;
  return decodeEntities(s.replace(/\s+/g, " ").trim());
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function absolutize(href: string | undefined, target: URL): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, target).toString();
  } catch {
    return href;
  }
}
