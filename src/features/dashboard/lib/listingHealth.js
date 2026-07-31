/**
 * Listing Health scoring — single source of truth.
 *
 * The implementation lives in supabase/functions/_shared/listingHealth.js so
 * the scheduled `health-refresh` edge function scores the catalog with the
 * EXACT same rules as the app. This module only re-exports it; add or change
 * checks over there, never here.
 */
export * from '../../../../supabase/functions/_shared/listingHealth.js';
