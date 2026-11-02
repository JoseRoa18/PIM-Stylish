/**
 * Price Alignment's margin (±10 from 200 up, ±5 under 200 — user,
 * 2026-11-02). The rule lives in supabase/functions/_shared/priceTolerance.js
 * so the daily health-refresh snapshot and walmart-pull-items judge a price
 * the same way as the report; this module only re-exports it.
 */
export * from '../../../../supabase/functions/_shared/priceTolerance.js';
