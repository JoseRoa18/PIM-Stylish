// Faucet categories — shared by the app (src/features/products/lib/categories.js
// re-exports this module) and the edge functions (completeness, Listing
// Health, Wayfair).
//
// "Kitchen Faucet Combo" and "Cold Water Tap" (user, 2026-10-08) are kitchen
// faucets for every rule, export and template: they only name the kind. A
// marketplace template tagged kitchen_faucet fits them, and every channel
// mapping reads them as kitchen_faucet (baseCategory).

export const KITCHEN_FAUCET_CATEGORIES = ['kitchen_faucet', 'kitchen_faucet_combo', 'cold_water_tap'];
export const FAUCET_CATEGORIES = [...KITCHEN_FAUCET_CATEGORIES, 'bathroom_faucet', 'pot_filler'];

export const isKitchenFaucetCategory = (category) => KITCHEN_FAUCET_CATEGORIES.includes(String(category ?? ''));
export const isFaucetCategory = (category) => FAUCET_CATEGORIES.includes(String(category ?? ''));

/** The category the channels and the marketplace templates know a product by. */
export const baseCategory = (category) => (isKitchenFaucetCategory(category) ? 'kitchen_faucet' : category);
