/**
 * Single source of truth for workflow statuses across the app.
 *
 * The catalog uses more statuses than the original UI assumed (it also has
 * `audit` and `re_launch`). Centralizing them here keeps the StatusBadge,
 * the Catalog KPI strip, and the dashboard charts consistent — and any new
 * status only needs to be added once.
 *
 * Each entry provides:
 *   - label:  human label
 *   - badge:  Tailwind bg + text classes for the pill (M3 container pattern)
 *   - dot:    solid color for legend dots / KPI markers
 *   - stroke: SVG stroke class for donut segments
 */
export const WORKFLOW_STATUS = {
  new: {
    label: 'New',
    badge: 'bg-primary-container text-on-primary-container',
    dot: 'bg-primary',
    stroke: 'stroke-primary',
  },
  audit: {
    label: 'Audit',
    badge: 'bg-warning-container text-on-warning-container',
    dot: 'bg-warning',
    stroke: 'stroke-warning',
  },
  in_review: {
    label: 'In Review',
    badge: 'bg-tertiary-container text-on-tertiary-container',
    dot: 'bg-tertiary',
    stroke: 'stroke-tertiary',
  },
  re_launch: {
    label: 'Re-Launch',
    badge: 'bg-secondary-container text-on-secondary-container',
    dot: 'bg-secondary',
    stroke: 'stroke-secondary',
  },
  ready_to_sell: {
    label: 'Ready to Sell',
    badge: 'bg-success-container text-on-success-container',
    dot: 'bg-success',
    stroke: 'stroke-success',
  },
  archived: {
    label: 'Archived',
    badge: 'bg-surface-container-high text-on-surface-variant',
    dot: 'bg-outline',
    stroke: 'stroke-outline',
  },
};

// Display order for legends / KPI cards (pipeline-ish, terminal states last).
export const STATUS_ORDER = [
  'ready_to_sell',
  'in_review',
  'audit',
  're_launch',
  'new',
  'archived',
];

const titleCase = (s) =>
  String(s || 'No status').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Any status not in the registry still renders gracefully (neutral grey).
export function statusMeta(key) {
  return (
    WORKFLOW_STATUS[key] ?? {
      label: titleCase(key),
      badge: 'bg-surface-container-high text-on-surface-variant',
      dot: 'bg-outline-variant',
      stroke: 'stroke-outline-variant',
    }
  );
}
