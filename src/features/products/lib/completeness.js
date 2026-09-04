/**
 * PIM data completeness — single source of truth.
 *
 * The implementation lives in supabase/functions/_shared/completeness.js so
 * the scheduled `health-refresh` edge function takes the daily KPI snapshot
 * with the EXACT same rules as the app. This module only re-exports it; add
 * or change checks over there, never here.
 */
export * from '../../../../supabase/functions/_shared/completeness.js';
