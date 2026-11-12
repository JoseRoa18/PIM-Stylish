/**
 * What a product's prices must keep to be saved — single source of truth.
 *
 * The implementation lives in supabase/functions/_shared/priceRules.js so the
 * `assistant` edge function checks a price change it is asked to prepare with
 * the EXACT same rules as the product page and the import preview. This module
 * only re-exports it; change a rule over there (and in the database's
 * price_problem()), never here.
 */
export * from '../../../../supabase/functions/_shared/priceRules.js';
