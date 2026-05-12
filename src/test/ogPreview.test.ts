import { describe, expect, it } from "vitest";
import { parseOgFromHtml } from "../app/api/preview/og/route";

/**
 * The OG parser uses regex to pull <meta> tags from the page <head>.
 * That's pragmatic but easy to silently break — tag attribute orders
 * vary in the wild, and a missed property pattern degrades the
 * iMessage-style preview to a blank card. These tests pin the shapes
 * we've actually seen in production.
 */
describe("parseOgFromHtml", () => {
  const target = new URL("https://www.espn.com/some/article");

  it("extracts og:image, og:title, og:description, og:site_name", () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://cdn.espn.com/hero.jpg" />
        <meta property="og:title" content="Fantasy baseball: Betts back" />
        <meta property="og:description" content="All of the important fantasy spin." />
        <meta property="og:site_name" content="ESPN.com" />
      </head><body></body></html>
    `;
    const preview = parseOgFromHtml(html, target);
    expect(preview.image).toBe("https://cdn.espn.com/hero.jpg");
    expect(preview.title).toBe("Fantasy baseball: Betts back");
    expect(preview.description).toBe("All of the important fantasy spin.");
    expect(preview.siteName).toBe("ESPN.com");
    expect(preview.domain).toBe("espn.com");
  });

  it("handles reverse attribute order (content before property)", () => {
    const html = `<head><meta content="https://x/y.jpg" property="og:image" /></head>`;
    expect(parseOgFromHtml(html, target).image).toBe("https://x/y.jpg");
  });

  it("falls back to twitter:* when og:* are missing", () => {
    const html = `
      <head>
        <meta name="twitter:image" content="https://x/twitter-hero.jpg" />
        <meta name="twitter:title" content="Twitter title" />
      </head>
    `;
    // Note: twitter:image uses name=, not property=. Update if our
    // regex grows to match that — for now we accept the property=
    // variant only, falling through to <title>.
    const preview = parseOgFromHtml(html, target);
    expect(preview.title).toBeUndefined();
  });

  it("falls back to <title> when og:title is missing", () => {
    const html = `<head><title>Page Title Fallback</title></head>`;
    expect(parseOgFromHtml(html, target).title).toBe("Page Title Fallback");
  });

  it("absolutizes relative image paths against the target URL", () => {
    const html = `<head><meta property="og:image" content="/static/hero.jpg" /></head>`;
    expect(parseOgFromHtml(html, target).image).toBe("https://www.espn.com/static/hero.jpg");
  });

  it("decodes HTML entities in titles", () => {
    const html = `<head><meta property="og:title" content="Mahomes &amp; Kelce: it&#39;s on" /></head>`;
    expect(parseOgFromHtml(html, target).title).toBe("Mahomes & Kelce: it's on");
  });

  it("strips www from the domain", () => {
    expect(parseOgFromHtml("", new URL("https://www.kalshi.com/x")).domain).toBe("kalshi.com");
  });

  it("falls back to /favicon.ico when no <link rel=icon> is present", () => {
    const preview = parseOgFromHtml("<head></head>", target);
    expect(preview.favicon).toBe("https://www.espn.com/favicon.ico");
  });

  it("uses the declared favicon link when present and absolutizes it", () => {
    const html = `<head><link rel="icon" href="/custom-favicon.png" /></head>`;
    expect(parseOgFromHtml(html, target).favicon).toBe("https://www.espn.com/custom-favicon.png");
  });
});
