import React, { useState } from "react";
import { HoverPopover } from "./HoverPopover";

/**
 * iMessage-style rich link preview.
 *
 * On hover/focus, lazily fetches OpenGraph metadata from /api/preview/og
 * and shows a polished card with the article's hero image, headline,
 * description, and source domain with favicon. Click the card to open
 * the article in a new tab.
 *
 * Position + portal logic lives in the shared <HoverPopover>. This
 * component is just the OG fetch + card markup.
 */

type OgPreview = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  domain?: string;
  favicon?: string;
};

type LinkPreviewProps = {
  href: string;
  children: React.ReactNode;
  fallbackTitle?: string;
  fallbackDescription?: string;
  className?: string;
};

const previewCache = new Map<string, OgPreview>();
const previewInflight = new Map<string, Promise<OgPreview | undefined>>();

async function fetchPreview(href: string): Promise<OgPreview | undefined> {
  const cached = previewCache.get(href);
  if (cached) return cached;
  const inflight = previewInflight.get(href);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const response = await fetch(`/api/preview/og?url=${encodeURIComponent(href)}`);
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { preview?: OgPreview };
      if (payload.preview) {
        previewCache.set(href, payload.preview);
        return payload.preview;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      previewInflight.delete(href);
    }
  })();
  previewInflight.set(href, promise);
  return promise;
}

export function LinkPreview({
  href,
  children,
  fallbackTitle,
  fallbackDescription,
  className
}: LinkPreviewProps) {
  const [preview, setPreview] = useState<OgPreview | undefined>(() => previewCache.get(href));

  const display = preview ?? {
    url: href,
    title: fallbackTitle,
    description: fallbackDescription,
    domain: tryHostname(href)
  };

  const card = (
    <a
      className="link-preview-card-link"
      href={display.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {display.image && (
        <div className="link-preview-card-hero">
          <img src={display.image} alt="" loading="lazy" />
        </div>
      )}
      <div className="link-preview-card-body">
        {display.title && <strong className="link-preview-card-title">{display.title}</strong>}
        {display.description && (
          <p className="link-preview-card-description">{display.description}</p>
        )}
        <div className="link-preview-card-footer">
          {display.favicon && (
            <img className="link-preview-card-favicon" src={display.favicon} alt="" loading="lazy" />
          )}
          <span>{display.siteName ?? display.domain ?? ""}</span>
        </div>
      </div>
    </a>
  );

  return (
    <HoverPopover
      cardClassName="link-preview-card"
      className={className}
      content={card}
      onOpen={() => {
        void fetchPreview(href).then((value) => {
          if (value) setPreview(value);
        });
      }}
    >
      {children}
    </HoverPopover>
  );
}

function tryHostname(href: string): string | undefined {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
