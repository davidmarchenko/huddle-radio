import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * iMessage-style rich link preview.
 *
 * Wraps a trigger element (typically an <a>). On hover or focus, lazily
 * fetches OpenGraph metadata from /api/preview/og and shows a polished
 * floating card with the article hero image, headline, source domain,
 * and a click-through link.
 *
 * Design notes:
 *   - Portals to document.body so the card escapes scroll/overflow
 *     clipping on the parent surface (storyline list, markets card).
 *   - Position is computed AFTER the card mounts and measures itself,
 *     so the card never appears at an interim wrong position. While
 *     measuring, the card is rendered with visibility: hidden — so the
 *     user only ever sees it in its final landing spot.
 *   - Edge-aware: prefers below-and-left-aligned to the trigger; flips
 *     to above when below would clip; clamps left to stay in viewport.
 *   - Stays open while the cursor moves into the card so links inside
 *     are reachable. Closes on leave + 140ms grace.
 *   - Fetches lazily — first hover triggers the OG load, subsequent
 *     hovers reuse the cached payload (server-side cache too).
 *   - Falls back gracefully when fetch fails or returns blank: shows
 *     just the headline + domain, no broken hero image.
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
  /** Children render as the trigger — typically an <a>. */
  children: React.ReactNode;
  /** Fallback title when OG fetch fails or returns blank. */
  fallbackTitle?: string;
  /** Fallback description when OG fetch returns blank. */
  fallbackDescription?: string;
  /** Optional class added to the trigger wrapper. */
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
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<OgPreview | undefined>(() => previewCache.get(href));
  const [coords, setCoords] = useState<{ top: number; left: number; placement: "bottom" | "top" } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = undefined;
    closeTimer.current = undefined;
  }, []);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const triggerRect = trigger.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    // Bail if the card hasn't laid out yet — we'll be called again
    // by the second RAF tick once it has real dimensions.
    if (cardRect.height < 20 || cardRect.width < 40) return;

    const margin = 10;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    // Default: anchor below the trigger, left-aligned.
    let placement: "bottom" | "top" = "bottom";
    let top = triggerRect.bottom + margin;
    if (top + cardRect.height + margin > viewportH) {
      // Not enough room below — flip above if there's room.
      const aboveTop = triggerRect.top - margin - cardRect.height;
      if (aboveTop >= margin) {
        top = aboveTop;
        placement = "top";
      } else {
        // No room either way — just clamp to the bottom edge.
        top = Math.max(margin, viewportH - cardRect.height - margin);
      }
    }

    let left = triggerRect.left;
    if (left + cardRect.width + margin > viewportW) {
      left = viewportW - cardRect.width - margin;
    }
    if (left < margin) left = margin;

    setCoords({ top, left, placement });
  }, []);

  // Schedule fetch + open after a short hover delay.
  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => {
      setOpen(true);
      void fetchPreview(href).then((value) => {
        if (value) setPreview(value);
      });
    }, 220);
  }, [clearTimers, href]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setCoords(null);
    }, 140);
  }, [clearTimers]);

  // Reposition on open / scroll / resize / preview content change
  // (fetched preview may add or remove the hero image, changing height).
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      computePosition();
      requestAnimationFrame(computePosition);
    });
    const onScroll = () => computePosition();
    const onResize = () => computePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, preview?.image, preview?.title, computePosition]);

  // ESC closes the card while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setCoords(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const display = preview ?? {
    url: href,
    title: fallbackTitle,
    description: fallbackDescription,
    domain: tryHostname(href)
  };

  return (
    <>
      <span
        ref={triggerRef}
        className={["link-preview-trigger", className].filter(Boolean).join(" ")}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
      >
        {children}
      </span>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={cardRef}
            role="tooltip"
            className="link-preview-card"
            data-placement={coords?.placement ?? "bottom"}
            style={
              coords
                ? { position: "fixed", top: coords.top, left: coords.left, visibility: "visible" }
                : { position: "fixed", top: 0, left: 0, visibility: "hidden" }
            }
            onMouseEnter={() => clearTimers()}
            onMouseLeave={scheduleClose}
          >
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
          </div>,
          document.body
        )}
    </>
  );
}

function tryHostname(href: string): string | undefined {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
