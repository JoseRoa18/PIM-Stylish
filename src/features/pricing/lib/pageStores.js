// The stores Price Alignment reads from their own product pages — the list
// lives in supabase/functions/_shared/pageStores.js so the Where to Buy audit
// (its re-read on promotion days) uses the same one.
export * from '../../../../supabase/functions/_shared/pageStores.js';
