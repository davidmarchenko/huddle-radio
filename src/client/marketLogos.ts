/**
 * Single source of truth for prediction-market source branding.
 *
 * Both providers ship official brand kits in `public/icons/Logos/{vendor}-logos/`.
 * We use the WHITE WORDMARK variants — they have transparent
 * backgrounds and read cleanly on the app's dark UI without needing
 * a colored band behind them.
 */

export type MarketSource = "kalshi" | "polymarket";

export function marketSourceLabel(source: MarketSource | string): string {
  return source === "kalshi" ? "Kalshi" : "Polymarket";
}

/** Path to the brand wordmark SVG (white fill, transparent background)
 *  served from /public. Used in market chips, ticker, board, picks,
 *  and the hover preview — every place the brand needs attribution. */
export function marketSourceLogoUrl(source: MarketSource | string): string {
  return source === "kalshi"
    ? "/icons/Logos/kalshi-logos/kalshi-logo-white-on-near-black.svg"
    : "/icons/Logos/polymarket-logos/logo-white.svg";
}

/** Square brand mark (icon-only). Used when the chip / badge can't
 *  spare horizontal space for the full wordmark. Polymarket ships a
 *  proper square icon; Kalshi only ships the wordmark, so we fall
 *  through to the wordmark for them — caller layout should handle
 *  the wider footprint gracefully. */
export function marketSourceIconUrl(source: MarketSource | string): string {
  if (source === "polymarket") return "/icons/Logos/polymarket-logos/icon-white.svg";
  return marketSourceLogoUrl(source);
}
