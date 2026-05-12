import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * RichHover — a small, portal-based hover/focus card.
 *
 * Use it for surfaces where the trigger is information-dense but the
 * full picture doesn't fit (truncated headlines, market chips, player
 * names). Portals to document.body so it escapes scroll/overflow
 * clipping in the parent (the markets ticker is horizontally scrollable;
 * the storyline list lives inside a card with rounded corners + clip).
 *
 * Behavior:
 *   - Opens after `openDelayMs` of pointer hover OR on focus
 *   - Closes after `closeDelayMs` of pointer leave + blur
 *   - Stays open while the pointer moves into the card, so users can
 *     interact with links inside it
 *   - Keyboard-accessible: ESC closes the card, focus inside is OK,
 *     trigger is wired with aria-describedby pointing to the card id
 *
 * Positioning: anchored to the trigger's getBoundingClientRect, with
 * automatic flip when the card would clip the viewport edge. No
 * dependency on a positioning library — the math is small and the
 * use cases are uniform (open below, fall back to above; left-align,
 * fall back to right-align).
 */
type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

type RichHoverProps = {
  children: React.ReactNode;
  content: React.ReactNode;
  /** Default placement if there's room. Auto-flips when constrained. */
  placement?: Placement;
  /** Delay before showing on hover. Avoids flicker on quick passes. */
  openDelayMs?: number;
  /** Delay before hiding on leave. Lets the user move into the card. */
  closeDelayMs?: number;
  /** Class added to the trigger wrapper (a span). */
  className?: string;
  /** Class added to the floating card. */
  cardClassName?: string;
  /** Render the trigger as a different element. Default: <span>. */
  as?: "span" | "div";
};

export function RichHover({
  children,
  content,
  placement = "bottom-start",
  openDelayMs = 180,
  closeDelayMs = 140,
  className,
  cardClassName,
  as = "span"
}: RichHoverProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; placement: Placement } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const id = useId();

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
    const rect = trigger.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const margin = 8;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    let chosen: Placement = placement;
    // Vertical flip: if there's not enough room below, flip above.
    const fitsBelow = rect.bottom + margin + cardRect.height < viewportH;
    const fitsAbove = rect.top - margin - cardRect.height > 0;
    if (chosen.startsWith("bottom") && !fitsBelow && fitsAbove) {
      chosen = chosen === "bottom-start" ? "top-start" : "top-end";
    } else if (chosen.startsWith("top") && !fitsAbove && fitsBelow) {
      chosen = chosen === "top-start" ? "bottom-start" : "bottom-end";
    }

    // Horizontal: left-aligned to trigger by default; flip to right-aligned
    // if the card would overflow the right edge.
    let left = chosen.endsWith("start") ? rect.left : rect.right - cardRect.width;
    if (left + cardRect.width + margin > viewportW) {
      left = viewportW - cardRect.width - margin;
    }
    if (left < margin) left = margin;

    const top = chosen.startsWith("bottom") ? rect.bottom + margin : rect.top - margin - cardRect.height;
    setCoords({ top, left, placement: chosen });
  }, [placement]);

  // Recompute position whenever the card opens, on scroll, on resize.
  useEffect(() => {
    if (!open) return;
    // Two ticks: first to let the card mount and measure, second to
    // settle the final coords after the browser paints.
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
  }, [open, computePosition]);

  // ESC closes when card is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), openDelayMs);
  }, [clearTimers, openDelayMs]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), closeDelayMs);
  }, [clearTimers, closeDelayMs]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const Tag = as as "span";
  return (
    <>
      <Tag
        ref={triggerRef}
        className={["rich-hover", className].filter(Boolean).join(" ")}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        aria-describedby={open ? id : undefined}
        tabIndex={0}
      >
        {children}
      </Tag>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={id}
            ref={cardRef}
            role="tooltip"
            className={["rich-hover-card", cardClassName].filter(Boolean).join(" ")}
            data-placement={coords?.placement ?? placement}
            style={
              coords
                ? { position: "fixed", top: coords.top, left: coords.left, opacity: 1 }
                : { position: "fixed", top: -9999, left: -9999, opacity: 0 }
            }
            onMouseEnter={() => clearTimers()}
            onMouseLeave={scheduleClose}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
