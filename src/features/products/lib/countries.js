/**
 * The country list — single source of truth.
 *
 * The list lives in supabase/functions/_shared/countries.js so the PIM
 * completeness check (also run by the `health-refresh` edge function) can
 * tell a real country from a typo with the SAME list as the dropdown. This
 * module only re-exports it; change the list over there, never here.
 */
export * from '../../../../supabase/functions/_shared/countries.js';
