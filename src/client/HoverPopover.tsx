import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Generic hover-driven popover. Shared by LinkPreview (iMessage-style
 * link cards) and MarketPreview (structured market summary), so the
 * positioning + visibility-while-measuring + portal logic only lives
 * in one place.
 *
 * Behavior:
 *   - Mounts the content into a portal at document.body so the card
 *     escapes scroll/overflow clipping in the parent surface.
 *   - Renders with visibility: hidden until measure-and-position
 *     completes — the user only ever sees the card in its final
 *     landed spot, never at an interim wrong position.
 *   - Edge-aware: prefers placement; flips the other axis when the
 *     preferred edge would clip; clamps to viewport.
 *   - Stays open while the cursor moves into the card so links inside
 *     are reachable; closes on leave + 140ms grace.
 *   - ESC closes; opens on hover (after 220ms delay) or on focus.
 *   - Lazy: `onOpen` callback fires the first time the popover opens,
 *     so consumers can defer expensive work (OG fetch) to that moment.
 */

type HoverPopoverProps = {
  /** The trigger element. Wrapped in a span so we can attach refs +
   *  hover/focus handlers without modifying the trigger markup. */
  children: React.ReactNode;
  /** The popover content. Re-rendered freely; positioning is recomputed
   *  whenever the content changes size. */
  content: React.ReactNode;
  /** Class on the popover card. */
  cardClassName?: string;
  /** Class on the trigger wrapper. */
  className?: string;
  /** Fires once each time the popover transitions from closed → open.
   *  Use it to lazy-fetch data so closed popovers don't pay the cost. */
  onOpen?: () => void;
  /** ms before showing on hover. Default 220 — long enough to skip
   *  accidental sweeps, short enough to not feel sluggish. */
  openDelayMs?: number;
  /** ms before hiding on leave. Default 140 — enough grace for the
   *  user to move into the popover. */
  closeDelayMs?: number;
};

export function HoverPopover({
  children,
  content,
  cardClassName,
  className,
  onOpen,
  openDelayMs = 220,
  closeDelayMs = 140
}: HoverPopoverProps) {
  const [open, setOpen] = useState(false);
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
    if (cardRect.height < 20 || cardRect.width < 40) return;

    const margin = 10;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    let placement: "bottom" | "top" = "bottom";
    let top = triggerRect.bottom + margin;
    if (top + cardRect.height + margin > viewportH) {
      const aboveTop = triggerRect.top - margin - cardRect.height;
      if (aboveTop >= margin) {
        top = aboveTop;
        placement = "top";
      } else {
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

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => {
      setOpen(true);
      onOpen?.();
    }, openDelayMs);
  }, [clearTimers, onOpen, openDelayMs]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setCoords(null);
    }, closeDelayMs);
  }, [clearTimers, closeDelayMs]);

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
  }, [open, content, computePosition]);

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

  return (
    <>
      <span
        ref={triggerRef}
        className={["hover-popover-trigger", className].filter(Boolean).join(" ")}
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
            className={["hover-popover-card", cardClassName].filter(Boolean).join(" ")}
            data-placement={coords?.placement ?? "bottom"}
            style={
              coords
                ? { position: "fixed", top: coords.top, left: coords.left, visibility: "visible" }
                : { position: "fixed", top: 0, left: 0, visibility: "hidden" }
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
