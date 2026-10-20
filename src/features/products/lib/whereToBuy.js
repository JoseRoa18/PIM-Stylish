/**
 * WHERE TO BUY — the store links of the Stylish product pages, owned by the
 * PIM (user, 2026-10-19). The registry, the address checks and the section
 * builder live in supabase/functions/_shared/whereToBuy.js so the product
 * page, the Listing Health audit and the push to Wix use the same ones.
 */
export * from '../../../../supabase/functions/_shared/whereToBuy.js';
