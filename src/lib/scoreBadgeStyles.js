/**
 * Score-tier badge classes for listing-health chips — the single source of
 * truth for every score badge (Listing Health page, dashboard overview,
 * marketplace health grid, action cards). Keys match `categorizeScore()`
 * tiers from features/dashboard/lib/listingHealth.
 *
 * The `good` tier uses the raw tertiary at low opacity plus a border instead
 * of tertiary-container: the container tone (#f5efe8) all but vanishes on
 * light surfaces. Every color resolves through var(--color-*), so the badge
 * re-themes automatically under `.dark` with no variant classes.
 */
export const SCORE_BADGE_STYLES = {
  excellent: 'bg-success-container text-on-success-container',
  good: 'bg-tertiary/25 text-on-tertiary-container border border-tertiary/40',
  needs_work: 'bg-warning-container text-on-warning-container',
  critical: 'bg-error-container text-on-error-container',
};

export default SCORE_BADGE_STYLES;
