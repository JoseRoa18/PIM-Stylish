// One channel's saved Price Alignment report reduced to its overview bar —
// shared by the Price Alignment tab and the Dashboard card so both read the
// same numbers from the same report (nothing is recomputed or pulled).

// Status segments in a fixed order; every segment is also named in the
// legend and in the row text, so identity never rides on color alone.
// Colors alternate lightness (dark-light-dark-light in BOTH themes) so
// adjacent segments stay separable under color-vision deficiency —
// validated with the palette checker, worst adjacent ΔE ≈ 38.
export const OVERVIEW_SEGMENTS = [
  { key: 'aligned', label: 'Aligned', cls: 'bg-success', of: (c) => (c.promo_ok ?? 0) + (c.map_ok ?? 0) },
  { key: 'promo_missing', label: 'Promo missing', cls: 'bg-warning-container', of: (c) => c.promo_missing ?? 0 },
  { key: 'misaligned', label: 'Misaligned / broken', cls: 'bg-error', of: (c) => (c.misaligned ?? 0) + (c.missing ?? 0) },
  { key: 'no_map', label: 'No price in PIM', cls: 'bg-outline-variant', of: (c) => c.no_map ?? 0 },
];

/**
 * @param report  loadLatestAlignment() result, or null
 * @returns { counts, parts, total, comparable, aligned, pct } — counts null
 *          when there is no usable report (none saved yet, or a legacy one)
 */
export function alignmentSummary(report) {
  const counts = report && !report.legacy ? report.counts : null;
  const parts = counts ? OVERVIEW_SEGMENTS.map((s) => ({ ...s, n: s.of(counts) })) : [];
  const total = parts.reduce((a, p) => a + p.n, 0);
  // % over what's comparable — a SKU with no price in the PIM says nothing
  // about the channel being right or wrong.
  const comparable = total - (counts?.no_map ?? 0);
  const aligned = parts.find((p) => p.key === 'aligned')?.n ?? 0;
  const pct = comparable > 0 ? Math.round((aligned / comparable) * 100) : null;
  return { counts, parts, total, comparable, aligned, pct };
}
